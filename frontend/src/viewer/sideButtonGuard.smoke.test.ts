// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 割り当てたサイドボタンの既定動作（ページの戻る・進む）を止めることの DOM テスト。実際にイベントを送り、defaultPrevented を見る。
import { describe, expect, it } from "vitest";
import { DEFAULT_MOUSE_BINDINGS, installSideButtonGuard, registerMouseCommandHandler, setMouseBindings, type MouseCommand } from "./mouseBindings";

function fire(type: string, button: number): MouseEvent {
  const e = new MouseEvent(type, { button, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
}

describe("サイドボタンの既定動作の抑止", () => {
  it("割り当てたボタンだけ、mousedown・mouseup・auxclick の既定動作を止める。割り当てなし・ほかのボタンは止めない", () => {
    installSideButtonGuard();
    installSideButtonGuard(); // 冪等

    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS }); // 既定: どちらも「なし」
    for (const t of ["mousedown", "mouseup", "auxclick"]) {
      expect(fire(t, 3).defaultPrevented).toBe(false);
      expect(fire(t, 4).defaultPrevented).toBe(false);
    }

    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS, back: "pan" });
    for (const t of ["mousedown", "mouseup", "auxclick"]) {
      expect(fire(t, 3).defaultPrevented).toBe(true); // 戻る: 割り当て済み
      expect(fire(t, 4).defaultPrevented).toBe(false); // 進む: 未割り当て
    }
    for (const b of [0, 1, 2]) expect(fire("mouseup", b).defaultPrevented).toBe(false);

    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS, back: "pan", forward: "windowLevel" });
    expect(fire("mouseup", 4).defaultPrevented).toBe(true);

    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS }); // 戻すと止めない
    expect(fire("mouseup", 3).defaultPrevented).toBe(false);
  });
});

function click(button: number, down: [number, number], up: [number, number]): void {
  const mk = (type: string, [x, y]: [number, number]) => new MouseEvent(type, { button, clientX: x, clientY: y, bubbles: true, cancelable: true });
  document.body.dispatchEvent(mk("mousedown", down));
  document.body.dispatchEvent(mk("mouseup", up));
}

describe("サイドボタンのクリックで操作を実行する", () => {
  it("操作の割り当てのとき、動かさずに離すと口が 1 回だけ呼ばれる。動かした・ツール・なし・口なしでは呼ばれない", () => {
    installSideButtonGuard();
    const calls: MouseCommand[] = [];
    const off = registerMouseCommandHandler((cmd) => calls.push(cmd));

    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS, back: "cmd:reset", forward: "cmd:invert" });
    click(3, [50, 50], [50, 50]);
    expect(calls).toEqual(["reset"]);
    click(4, [50, 50], [52, 51]);
    expect(calls).toEqual(["reset", "invert"]);

    click(3, [50, 50], [90, 50]); // ドラッグ
    expect(calls).toHaveLength(2);

    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS, back: "pan", forward: "none" }); // ツール・なし
    click(3, [50, 50], [50, 50]);
    click(4, [50, 50], [50, 50]);
    expect(calls).toHaveLength(2);

    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS, back: "cmd:fit" });
    for (const b of [0, 1, 2]) click(b, [1, 1], [1, 1]); // 左・中・右では呼ばれない
    expect(calls).toHaveLength(2);

    off(); // 口を外す（動画だけの窓など）
    click(3, [50, 50], [50, 50]);
    expect(calls).toHaveLength(2);
    // 操作の割り当てでも、既定動作の抑止は従来どおり（口が無くても止める）
    expect(fire("mouseup", 3).defaultPrevented).toBe(true);
    setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS });
  });
});
