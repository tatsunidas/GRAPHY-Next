/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, acknowledge, isIdle, step, type StoreRefreshState } from "./storeRefreshView";

const at = (baseline: number, lastSeen: number): StoreRefreshState => ({ baseline, lastSeen });

describe("step", () => {
  it("最初の応答は基準にするだけ（開く前に届いていた分では促さない）", () => {
    const r = step(INITIAL_STATE, 7, true);
    expect(r.action).toBe("none");
    expect(r.state).toEqual(at(7, 7));
  });

  it("番号が動かなければ何もしない", () => {
    expect(step(at(7, 7), 7, true).action).toBe("none");
    expect(step(at(7, 7), 7, false).action).toBe("none");
  });

  it("待機中で、番号が進んで落ち着いたら自動で読み直す", () => {
    const first = step(at(7, 7), 9, true); // 進んだ直後はまだ動いているかもしれない
    expect(first.action).toBe("none");
    const second = step(first.state, 9, true); // 次の問い合わせでも同じ → 落ち着いた
    expect(second.action).toBe("auto");
  });

  it("転送の途中（番号が動き続けている）は、待機中でも読み直さない", () => {
    let s = at(0, 0);
    for (const v of [3, 8, 15, 22]) {
      const r = step(s, v, true);
      expect(r.action).toBe("none");
      s = r.state;
    }
    expect(step(s, 22, true).action).toBe("auto");
  });

  it("負例: 操作中は自動で読み直さず、通知にする（動いている最中でも通知）", () => {
    expect(step(at(7, 7), 9, false).action).toBe("notify");
    expect(step(at(7, 9), 9, false).action).toBe("notify");
  });

  it("番号が基準より小さい（再起動・DB の切り替え）ときは、基準を引き直し、促さない", () => {
    const r = step(at(50, 50), 3, true);
    expect(r.action).toBe("none");
    expect(r.state).toEqual(at(3, 3));
    expect(step(r.state, 3, false).action).toBe("none");
  });
});

describe("acknowledge / isIdle", () => {
  it("読み直したら、見えている番号が基準になり、通知が消える", () => {
    const s = acknowledge(at(7, 9));
    expect(s).toEqual(at(9, 9));
    expect(step(s, 9, false).action).toBe("none");
  });

  it("まだ何も見ていなければ変えない", () => {
    expect(acknowledge(INITIAL_STATE)).toEqual(INITIAL_STATE);
  });

  it("待機中は、何も選んでいなく、一覧が操作中でないとき", () => {
    expect(isIdle({ selected: false, listBusy: false })).toBe(true);
    expect(isIdle({ selected: true, listBusy: false })).toBe(false);
    expect(isIdle({ selected: false, listBusy: true })).toBe(false);
  });
});
