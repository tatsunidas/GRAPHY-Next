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
  /**
   * ドラッグの始点（canvas 内の相対位置 0〜1）。既定は中央。
   * 複数の注釈を作るときは**始点をずらす**こと: 既定の中央から引くと、既にそこにある注釈の
   * ハンドルを掴んで「新規作成ではなく既存の移動」になる（実機で踏んだ）。
   */
  start: { fracX: number; fracY: number } = { fracX: 0.5, fracY: 0.5 },
): Promise<void> {
  const buttons = button === 0 ? 1 : button === 1 ? 4 : 2;
  const args = JSON.stringify({ hostTestId, dx, dy, button, buttons, steps, start });
  await page.evaluate(`
    (function (args) {
      var host = document.querySelector('[data-testid="' + args.hostTestId + '"]');
      var canvas = host && host.querySelector("canvas");
      if (!canvas) throw new Error('canvas not found under [data-testid="' + args.hostTestId + '"]');
      var rect = canvas.getBoundingClientRect();
      var cx = rect.left + rect.width * args.start.fracX;
      var cy = rect.top + rect.height * args.start.fracY;
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
 * 画像中央を中心に、血管軸（水平）へ ±`halfSpanMm` の計測を引く。
 *
 * 🚨 **長さは CSS px で決める。`canvas.width/height`（描画バッファ）で決めてはいけない。**
 * `dragOnCanvasHost` は `getBoundingClientRect()` と `clientX/clientY` ＝ **CSS px** で動くが、
 * `getViewportGeometry()` が返す `canvas.width/height` は**描画バッファ**の大きさで、
 * これは CSS px × `devicePixelRatio` になる。DPR=1 の環境では一致するので気づけないが、
 * **Windows の表示スケーリング 200%（DPR=2）では長さが 2 倍**になり、80mm のつもりの区間が
 * 160mm になって画像（GNBP-XA-1 は 115.2mm 角）の外へ落ちる。すると `tracePath` が null を返し、
 * **「中心線を引けない／エッジが検出できない」で全フレームが落ちる**（2026-08-17 に実際に踏んだ。
 * 画面上は線が引けているように見えるので、エラー文だけ見ても原因に辿り着けない）。
 *
 * <p>`parallelScale` はビューポート**高さの半分**に相当する world 長 [mm] なので、
 * mm/CSSpx = 2·parallelScale ÷ (canvas の CSS 高さ)。
 */
export async function dragSpanMmOnCanvasHost(
  page: Page,
  hostTestId: string,
  halfSpanMm: number,
  opts: { fracY?: number; steps?: number } = {},
): Promise<{ spanCssPx: number; mmPerCssPx: number }> {
  const raw = (await page.evaluate(`(() => {
    const g = window.__graphyDebug;
    const geo = g && g.getViewportGeometry ? g.getViewportGeometry() : null;
    if (!geo || !geo.length) return null;
    const host = document.querySelector('[data-testid="${hostTestId}"]');
    const canvas = host && host.querySelector("canvas");
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return JSON.stringify({ ps: geo[0].camera.parallelScale, cssW: r.width, cssH: r.height });
  })()`)) as string | null;
  if (!raw) throw new Error("ビューポートの幾何を取得できませんでした");
  const { ps, cssW, cssH } = JSON.parse(raw) as { ps: number; cssW: number; cssH: number };
  const mmPerCssPx = (2 * ps) / cssH;
  const halfPx = halfSpanMm / mmPerCssPx;
  if (halfPx * 2 < 20) {
    throw new Error(`表示が小さすぎて区間を引けません（${(halfPx * 2).toFixed(1)} CSS px）`);
  }
  await dragOnCanvasHost(page, hostTestId, Math.round(halfPx * 2), 0, 0, opts.steps ?? 12, {
    fracX: 0.5 - halfPx / cssW,
    fracY: opts.fracY ?? 0.5,
  });
  await page.waitForTimeout(800);
  return { spanCssPx: halfPx * 2, mmPerCssPx };
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
