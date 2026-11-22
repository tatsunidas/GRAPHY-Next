// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 割り当てたサイドボタンの既定動作（ページの戻る・進む）を止めることの DOM テスト。実際にイベントを送り、defaultPrevented を見る。
import { describe, expect, it } from "vitest";
import { DEFAULT_MOUSE_BINDINGS, installSideButtonGuard, setMouseBindings } from "./mouseBindings";

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
