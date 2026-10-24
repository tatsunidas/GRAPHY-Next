import { describe, expect, it } from "vitest";
import { publishSlice, registerSliceSync, type SliceSyncState } from "./sliceSync";

/** 同じ向き・同じ座標の Z スタック（10 枚、1mm 間隔）。同期は座標一致で動く。 */
function stack(index: number): SliceSyncState {
  const ipps = Array.from({ length: 10 }, (_, z) => [0, 0, z] as const);
  return { index, nZ: 10, ipps, normal: [0, 0, 1] };
}

/** 参加者を作る。applied に、同期で動かされた Z が積まれる。 */
function member(id: string, group: string | undefined, index: number) {
  const state = { index };
  const applied: number[] = [];
  const unregister = registerSliceSync({
    id,
    group,
    getState: () => stack(state.index),
    applyIndex: (z) => {
      state.index = z;
      applied.push(z);
    },
  });
  return { state, applied, unregister };
}

describe("sliceSync: 患者（group）をまたいだ連動の防止", () => {
  it("同じ group のタイルは連動する（正例）", () => {
    const a = member("t-a", "P1", 0);
    const b = member("t-b", "P1", 0);
    a.state.index = 4;
    publishSlice("t-a");
    expect(b.applied).toEqual([4]);
    a.unregister();
    b.unregister();
  });

  it("別の group のタイルは、座標が同じでも連動しない（負例）", () => {
    const a = member("t-a", "P1", 0);
    const b = member("t-b", "P2", 0);
    a.state.index = 4;
    publishSlice("t-a");
    expect(b.applied).toEqual([]);
    a.unregister();
    b.unregister();
  });

  it("group 未指定同士は従来どおり連動する", () => {
    const a = member("t-a", undefined, 0);
    const b = member("t-b", undefined, 0);
    a.state.index = 3;
    publishSlice("t-a");
    expect(b.applied).toEqual([3]);
    a.unregister();
    b.unregister();
  });
});
