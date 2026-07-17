import type { Page } from "@playwright/test";

/**
 * canvas要素に対して、生のPointerEvent(pointerdown→pointermove×N→pointerup)を直接dispatchして
 * ドラッグ操作をシミュレートする。
 *
 * 実機で確認した罠その1: この環境（Electron + Cornerstone3D-tools）では Playwright の
 * `page.mouse.down/move/up`（CDP経由でmouseイベントのみ合成する）を使ってもCornerstone3D-tools
 * のツール（WindowLevelTool/PanTool/ZoomTool等）が一切反応しない。これらはpointerdown/pointermove/
 * pointerupを購読しており、対応するpointerイベントが合成されないためと見られる。生のPointerEvent
 * をcanvasへ直接dispatchすると正しく動作する。
 *
 * 実機で確認した罠その2: page.evaluate() に「名前付きの内部関数（const fire = (...) => {} 等）」
 * を含む関数を*参照*として渡すと、tsx(esbuild)がコンパイル時に挿入する `__name(...)` ヘルパー
 * 呼び出しがブラウザ側の評価コンテキストに存在せず `ReferenceError: __name is not defined` になる
 * （単純な一行アロー関数では発生しない）。文字列として評価させることで回避する。
 */
export async function dragOnCanvasHost(
  page: Page,
  hostTestId: string,
  dx: number,
  dy: number,
  button: 0 | 1 | 2,
  steps = 10,
): Promise<void> {
  const buttons = button === 0 ? 1 : button === 1 ? 4 : 2;
  const args = JSON.stringify({ hostTestId, dx, dy, button, buttons, steps });
  await page.evaluate(`
    (function (args) {
      var host = document.querySelector('[data-testid="' + args.hostTestId + '"]');
      var canvas = host && host.querySelector("canvas");
      if (!canvas) throw new Error('canvas not found under [data-testid="' + args.hostTestId + '"]');
      var rect = canvas.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      function fire(type, x, y, btns) {
        var common = {
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, button: args.button, buttons: btns,
        };
        canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), common));
      }
      fire("pointerdown", cx, cy, args.buttons);
      for (var i = 1; i <= args.steps; i++) {
        fire("pointermove", cx + (args.dx * i) / args.steps, cy + (args.dy * i) / args.steps, args.buttons);
      }
      fire("pointerup", cx + args.dx, cy + args.dy, 0);
    })(${args})
  `);
}

/**
 * canvas要素上の相対位置(0〜1)へ、ボタンを押さないポインタ移動（hover）を生イベントで送る。
 * Viewer2D.tsx のカーソル位置サンプリング(onMove)向け。page.mouse.move() では発火しないことを
 * 実機で確認したため、dragOnCanvasHost と同じ生イベントdispatch方式を使う。
 */
export async function moveOnCanvasHost(page: Page, hostTestId: string, fracX: number, fracY: number): Promise<void> {
  const args = JSON.stringify({ hostTestId, fracX, fracY });
  await page.evaluate(`
    (function (args) {
      var host = document.querySelector('[data-testid="' + args.hostTestId + '"]');
      var canvas = host && host.querySelector("canvas");
      if (!canvas) throw new Error('canvas not found under [data-testid="' + args.hostTestId + '"]');
      var rect = canvas.getBoundingClientRect();
      var x = rect.left + rect.width * args.fracX;
      var y = rect.top + rect.height * args.fracY;
      var common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: -1, buttons: 0 };
      canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, common, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
      canvas.dispatchEvent(new MouseEvent("mousemove", common));
    })(${args})
  `);
}
