/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { beforeAll, describe, expect, it } from "vitest";
import { nearestReal, nextRealLoop, realZs, stepReal } from "./realSlices";
import { buildLayoutFromDto, type SeriesLayout } from "./seriesLayout";
import type { SeriesLayoutDto } from "../api";

// apiBase() は window から backend URL を読む（Electron 用）。node 環境なので空にしておく。
beforeAll(() => {
  (globalThis as { window?: unknown }).window = {};
});

/** 刻みの違う 2 相を 1 シリーズに入れたレイアウトの DTO（2.5 mm の 97 枚 = T0、5.0 mm の 51 枚 = T1。z の和集合 99 位置）。 */
function twoPhaseDto(): SeriesLayoutDto {
  const zs: number[] = [];
  const t0 = new Set<number>();
  const t1 = new Set<number>();
  for (let i = 0; i < 97; i++) t0.add(Math.round((-350 + i * 2.5) * 1000));
  for (let i = 0; i < 51; i++) t1.add(Math.round((-350 + i * 5) * 1000));
  const union = [...new Set([...t0, ...t1])].sort((a, b) => a - b);
  union.forEach((k) => zs.push(k / 1000));
  const cells: SeriesLayoutDto["cells"] = [];
  union.forEach((k, z) => {
    if (t0.has(k)) cells.push({ c: 0, t: 0, z, sopInstanceUid: `a${z}`, frame: -1 });
    if (t1.has(k)) cells.push({ c: 0, t: 1, z, sopInstanceUid: `b${z}`, frame: -1 });
  });
  return {
    nZ: union.length, nC: 1, nT: 2, cells,
    zSpatial: zs.map((z, i) => ({ z: i, imagePositionPatient: [0, 0, z] as [number, number, number] })),
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
  } as unknown as SeriesLayoutDto;
}

describe("realZs on the two-phase layout (97 images at 2.5 mm + 51 images at 5.0 mm)", () => {
  let layout: SeriesLayout;
  beforeAll(() => {
    layout = buildLayoutFromDto(twoPhaseDto(), "standalone", "st", "se")!;
  });

  it("uses a shared axis of the union of positions", () => {
    expect(layout.nZ).toBe(99);
  });

  it("T0 has a gap-free run of its own images, T1 only its 51 real images", () => {
    // T0 は和集合 99 位置のうち 97 枚（5.0 mm 刻みの末尾 2 位置が欠ける）、T1 は 51 枚
    expect(realZs(layout, 0, 0)!.length).toBe(97);
    const t1 = realZs(layout, 0, 1)!;
    expect(t1.length).toBe(51);
    // 2.5 mm 格子の 1 つおきにしか実画像が無い区間では、実画像の間にブランク位置が 1 つ挟まる（旧動作ではここで暗い画像が交互に出た）
    for (let i = 1; i <= 48; i++) expect(t1[i] - t1[i - 1]).toBe(2);
  });

  it("the blank positions are exactly where zStack puts a blank id", () => {
    const stack = layout.zStack(0, 1);
    const real = new Set(realZs(layout, 0, 1)!);
    stack.forEach((id, z) => expect(id.includes("/blank/file")).toBe(!real.has(z)));
  });
});

describe("realZs", () => {
  it("returns null when nothing is missing, unknown, or nothing is real", () => {
    expect(realZs({ nZ: 5 }, 0, 0)).toBeNull();
    expect(realZs({ nZ: 3, hasImage: () => true }, 0, 0)).toBeNull();
    expect(realZs({ nZ: 3, hasImage: () => false }, 0, 0)).toBeNull();
  });

  it("works for the C dimension too (c is passed through)", () => {
    const has = (c: number, _t: number, z: number) => c === 0 || z % 2 === 0;
    expect(realZs({ nZ: 6, hasImage: has }, 0, 0)).toBeNull();
    expect(realZs({ nZ: 6, hasImage: has }, 1, 0)).toEqual([0, 2, 4]);
  });
});

describe("stepReal / nextRealLoop", () => {
  const list = [0, 2, 4, 6];
  it("moves along the list and stops at both ends", () => {
    expect(stepReal(list, 2, 1)).toBe(4);
    expect(stepReal(list, 2, -1)).toBe(0);
    expect(stepReal(list, 6, 1)).toBe(6);
    expect(stepReal(list, 0, -1)).toBe(0);
    expect(stepReal(list, 0, 3)).toBe(6);
  });
  it("from a blank position, the first step lands on the nearest real image in that direction", () => {
    expect(stepReal(list, 3, 1)).toBe(4);
    expect(stepReal(list, 3, -1)).toBe(2);
    expect(stepReal(list, 3, 2)).toBe(6);
    expect(stepReal(list, 9, 1)).toBe(6);
    expect(stepReal(list, -1, -1)).toBe(0);
  });
  it("loops for playback and never lands on a blank", () => {
    let z = 0;
    const seen: number[] = [];
    for (let i = 0; i < 9; i++) { z = nextRealLoop(list, z); seen.push(z); }
    expect(seen).toEqual([2, 4, 6, 0, 2, 4, 6, 0, 2]);
  });
});

describe("nearestReal", () => {
  const ip = (pos: number[]) => (z: number): [number, number, number] | null => (pos[z] === undefined ? null : [0, 0, pos[z]]);
  it("keeps a Z that is already real", () => {
    expect(nearestReal([0, 2], 2)).toBe(2);
  });
  it("uses the physical position, not the index", () => {
    // 位置 0,1,2,10: Z=2(2 mm) の最寄りは Z=1 ではなく… 実画像 {0,3} のうち Z=0 (2 mm) が Z=3 (10 mm) より近い
    expect(nearestReal([0, 3], 2, ip([0, 1, 2, 10]), [0, 0, 1])).toBe(0);
    // 同じ入力を番号で比べると Z=3 が近い（物理位置を使わない旧い見方では逆になる）
    expect(nearestReal([0, 3], 2)).toBe(3);
  });
  it("falls back to the index when a position is unknown (no unit mixing)", () => {
    expect(nearestReal([0, 3], 2, ip([0, 1, 2]), [0, 0, 1])).toBe(3);
  });
  it("ties go to the smaller Z", () => {
    expect(nearestReal([0, 2], 1)).toBe(0);
  });
});
