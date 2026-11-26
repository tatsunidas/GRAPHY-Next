/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** H80・H81: ラベルマップのマスクの読み出し（模擬の labelmap で）。 */
import { describe, expect, it } from "vitest";
import { listSegmentsForStack, readSegmentMask, type SegmentAccess } from "./segmentMask";

const COLS = 4;
const ROWS = 3;
const FRAME = COLS * ROWS;
const STACK = ["src/0", "src/1", "src/2", "src/3"];

/** 4 スライスのスタックに乗った labelmap。z=1 に segment 1 が 3 画素・segment 2 が 1 画素、z=2 に segment 1 が 2 画素。 */
function makeAccess(over: Partial<{ stack: string[]; planes: Record<string, Uint8Array>; segments: number[]; meta: SegmentAccess["metaOf"] }> = {}): {
  access: SegmentAccess;
  planes: Record<string, Uint8Array>;
} {
  const lmIds = STACK.map((_, z) => `lm/${z}`);
  const planes: Record<string, Uint8Array> =
    over.planes ??
    Object.fromEntries(
      lmIds.map((id, z) => {
        const p = new Uint8Array(FRAME);
        if (z === 1) { p[0] = 1; p[1] = 1; p[5] = 1; p[6] = 2; }
        if (z === 2) { p[3] = 1; p[7] = 1; }
        return [id, p];
      }),
    );
  const referenced = over.stack ?? STACK;
  const access: SegmentAccess = {
    segmentationIds: () => ["segA", "segOther"],
    labelmapImageIds: (id) => (id === "segA" ? lmIds : id === "segOther" ? ["lmX/0", "lmX/1"] : undefined),
    referencedImageId: (lm) => (lm.startsWith("lmX") ? "other/" + lm : referenced[lmIds.indexOf(lm)]),
    plane: (lm) => planes[lm] ?? null,
    planeSize: () => ({ cols: COLS, rows: ROWS }),
    sopOf: (src) => `sop-of-${src}`,
    segmentsOf: () => over.segments ?? [1, 2],
    metaOf: over.meta ?? (() => ({ label: "Liver mask", segmentLabels: { "1": "liver" } })),
  };
  return { access, planes };
}

describe("H80 listSegments", () => {
  it("★ このスタックに乗っているセグメントだけを返す（別スタックの segmentation は出ない）", () => {
    const { access } = makeAccess();
    const segs = listSegmentsForStack(access, STACK);
    expect(segs.map((s) => [s.segmentationId, s.segmentIndex])).toEqual([["segA", 1], ["segA", 2]]);
    expect(segs[0]).toMatchObject({ label: "Liver mask", segmentLabel: "liver" });
  });
  it("★ 名前が無ければ null（名前を作らない）", () => {
    const { access } = makeAccess({ meta: () => ({ label: "  ", segmentLabels: {} }) });
    const segs = listSegmentsForStack(access, STACK);
    expect(segs.every((s) => s.label === null && s.segmentLabel === null)).toBe(true);
  });
  it("負例: スタックが違う（参照先の並びが違う）・空のスタックでは何も出ない", () => {
    expect(listSegmentsForStack(makeAccess({ stack: [...STACK].reverse() }).access, STACK)).toEqual([]);
    expect(listSegmentsForStack(makeAccess().access, [])).toEqual([]);
    expect(listSegmentsForStack(makeAccess().access, STACK.slice(0, 3))).toEqual([]);
  });
});

describe("H81 loadSegmentMask", () => {
  it("★ 指定した segment だけが 1。前景のあるスライスだけ・スタック順の sliceIndex・ボクセル数が一致", () => {
    const { access } = makeAccess();
    const m = readSegmentMask(access, STACK, "segA", 1)!;
    expect(m.cols).toBe(COLS);
    expect(m.rows).toBe(ROWS);
    expect(m.slices.map((s) => s.sliceIndex)).toEqual([1, 2]);
    expect(m.voxelCount).toBe(5);
    expect(Array.from(m.slices[0].data)).toEqual([1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // segment 2 の画素（添字 6）は 0
    expect(m.slices[0].sopInstanceUid).toBe("sop-of-src/1");
    const m2 = readSegmentMask(access, STACK, "segA", 2)!;
    expect(m2.voxelCount).toBe(1);
    expect(m2.slices.map((s) => s.sliceIndex)).toEqual([1]);
  });
  it("★ コピーを返す: 返した配列を書き換えても labelmap は変わらない", () => {
    const { access, planes } = makeAccess();
    const before = Array.from(planes["lm/1"]);
    const m = readSegmentMask(access, STACK, "segA", 1)!;
    m.slices[0].data.fill(0);
    expect(Array.from(planes["lm/1"])).toEqual(before);
  });
  it("★ 負例: 未知の id・別スタック・登録に無い segment・0 以下や非整数の index・前景が無い、は null", () => {
    const { access } = makeAccess();
    expect(readSegmentMask(access, STACK, "nope", 1)).toBeNull();
    expect(readSegmentMask(access, STACK, "segOther", 1)).toBeNull();
    expect(readSegmentMask(access, [...STACK].reverse(), "segA", 1)).toBeNull();
    expect(readSegmentMask(access, STACK, "segA", 3)).toBeNull();
    expect(readSegmentMask(access, STACK, "segA", 0)).toBeNull();
    expect(readSegmentMask(access, STACK, "segA", 1.5)).toBeNull();
    expect(readSegmentMask(makeAccess({ segments: [1, 2, 9] }).access, STACK, "segA", 9)).toBeNull(); // 登録はあるが前景が無い
  });
  it("★ 負例: 上限を超えるときは、理由つきの例外（黙って切らない）", () => {
    const { access } = makeAccess();
    expect(() => readSegmentMask(access, STACK, "segA", 1, FRAME)).toThrow(/too large/);
    expect(readSegmentMask(access, STACK, "segA", 1, FRAME * 2)).not.toBeNull(); // ちょうど足りるなら通る
  });
  it("画素が取れないスライスは飛ばす（ほかのスライスは返す）", () => {
    const { access, planes } = makeAccess();
    delete planes["lm/1"];
    const m = readSegmentMask(access, STACK, "segA", 1)!;
    expect(m.slices.map((s) => s.sliceIndex)).toEqual([2]);
  });
});
