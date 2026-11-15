import { beforeEach, describe, expect, it, vi } from "vitest";

/** imageId → { ipp, ball 中心との位置関係から作った画素 }。 */
const stack = new Map<string, { ipp: [number, number, number]; pixels: Int16Array }>();
let iopNow: number[] = [1, 0, 0, 0, 1, 0];
const created: Array<{ id: string; opts: Record<string, unknown> }> = [];

vi.mock("@cornerstonejs/core", async (orig) => {
  const real = await orig<typeof import("@cornerstonejs/core")>();
  return {
    ...real,
    imageLoader: { loadAndCacheImage: vi.fn(async () => ({})) },
    metaData: {
      get: (module: string, id: string) => {
        const s = stack.get(id);
        if (module === "imagePlaneModule" && s) {
          return { imageOrientationPatient: iopNow, imagePositionPatient: s.ipp, columns: COLS, rows: ROWS, pixelSpacing: [1, 1], sliceThickness: 2.5 };
        }
        return {};
      },
    },
    cache: { getImage: (id: string) => ({ getPixelData: () => stack.get(id)!.pixels }) },
    volumeLoader: { createLocalVolume: (id: string, opts: Record<string, unknown>) => { created.push({ id, opts }); } },
  };
});
vi.mock("./pixelCalibration", () => ({ getModalityCalibration: () => ({ scale: 1, offset: 0 }) }));

import { buildMprVolume, assembleCtSourceVolume } from "./mpr";
import { correctGantryTilt } from "./gantryTiltCorrect";
import { regularGrid, sliceGeometry } from "./sliceGeometry";
import { sliceInfosOf } from "./sliceInfoMeta";

const COLS = 3, ROWS = 40, DZ = 2.5, N = 24;
const TILT = (15 * Math.PI) / 180;
/** 患者座標の球（標識）。中心の z が補正後の体積でどこに出るかを測る。 */
const BALL = { c: [1, 14, 44], r: 6 };

/** IPP の z の列から、傾いた（IOP の行方向が傾く）スタックを作る。画素は患者座標の球から（アプリの式を使わない）。 */
function makeStack(zs: number[], tilted: boolean): string[] {
  stack.clear();
  iopNow = tilted ? [1, 0, 0, 0, Math.cos(TILT), Math.sin(TILT)] : [1, 0, 0, 0, 1, 0];
  const rr = iopNow.slice(3);
  return zs.map((z, k) => {
    const id = `img:${k}`;
    const ipp: [number, number, number] = [0, 0, z];
    const px = new Int16Array(COLS * ROWS);
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const p = [ipp[0] + i, ipp[1] + j * rr[1], ipp[2] + j * rr[2]];
      const d = Math.hypot(p[0] - BALL.c[0], p[1] - BALL.c[1], p[2] - BALL.c[2]);
      px[j * COLS + i] = d <= BALL.r ? 1000 : 0;
    }
    stack.set(id, { ipp, pixels: px });
    return id;
  });
}
const range = (n: number) => Array.from({ length: n }, (_, k) => k * DZ);

/** 補正後の体積の球（値 > 500）の z 方向の重心（患者 z, mm）を返す。 */
async function corrected(ids: string[], withGeometry: boolean) {
  const geometry = sliceGeometry(sliceInfosOf(ids));
  const src = (await assembleCtSourceVolume(ids, undefined, withGeometry ? geometry : undefined))!;
  const tiltDeg = (Math.atan2(src.iop[5], src.iop[4]) * 180) / Math.PI;
  const c = correctGantryTilt(src, tiltDeg);
  let sum = 0, n = 0;
  const len = c.width * c.height;
  for (let k = 0; k < c.depth; k++) for (let i = 0; i < len; i++) if (c.data[k * len + i] > 500) { sum += c.origin[2] + k * c.spacing[2]; n++; }
  return { src, z: sum / n, c, nBall: n };
}

describe("チルト補正の前に、欠損・不等間隔を格子に載せる", () => {
  beforeEach(() => { created.length = 0; BALL.c[2] = 44; });

  it("等間隔のチルトは従来どおり（depth = 枚数、sliceSpacing = IPP 間隔、格子なし）", async () => {
    const ids = makeStack(range(N), true);
    const src = (await assembleCtSourceVolume(ids, undefined, sliceGeometry(sliceInfosOf(ids))))!;
    expect(src.depth).toBe(N);
    expect(src.sliceSpacing).toBeCloseTo(DZ, 9);
    expect(src.grid).toBeUndefined();
  });

  it("1 枚欠損のチルト: depth = 格子の層数、sliceSpacing = 最小間隔（IPP 間隔）", async () => {
    const zs = range(N).filter((_, k) => k !== 11);
    const ids = makeStack(zs, true);
    const src = (await assembleCtSourceVolume(ids, undefined, sliceGeometry(sliceInfosOf(ids))))!;
    expect(src.depth).toBe(N);
    expect(src.sliceSpacing).toBeCloseTo(DZ, 6);
    expect(src.grid?.count).toBe(N);
    expect(src.ippLast).toEqual([0, 0, zs[zs.length - 1]]); // 端点は元のまま
  });

  it("1 枚欠損: 補正後の球の z が、欠損なしの同じ体積と 0.5 mm 以内で一致する（格子なしの旧い組み方では一致しない）", async () => {
    const full = await corrected(makeStack(range(N), true), true);
    const miss = makeStack(range(N).filter((_, k) => k !== 11), true);
    const fixed = await corrected(miss, true);
    const old = await corrected(miss, false);
    expect(Math.abs(fixed.z - full.z)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(old.z - full.z)).toBeGreaterThan(0.5); // 検出器が旧い挙動を落とせること
    // 球の中心（患者座標 z = 44）との差も小さい
    expect(Math.abs(fixed.z - BALL.c[2])).toBeLessThanOrEqual(1.5);
  });

  it("不等間隔のチルトも同様（最小間隔の格子に載り、欠損なし等間隔との差が 0.5 mm 以内）", async () => {
    // 前半 2 mm・後半 3.5 mm の不等間隔（平均間隔の組み方だと接合部の付近が最もずれる）。球は接合部の上に置く
    const zs = [0];
    for (let k = 0; k < N - 1; k++) zs.push(zs[k] + (k < 12 ? 2 : 3.5));
    BALL.c[2] = 28;
    const ids = makeStack(zs, true);
    const geometry = sliceGeometry(sliceInfosOf(ids));
    expect(geometry.kind).toBe("irregular");
    const src = (await assembleCtSourceVolume(ids, undefined, geometry))!;
    expect(src.depth).toBe(regularGrid(geometry).count);
    expect(src.sliceSpacing).toBeCloseTo(2, 6);
    // 同じ位置（IPP の z）に等間隔 2 mm で撮った対照体積
    const lo = zs[0], hi = zs[zs.length - 1];
    const dense = makeStack(Array.from({ length: Math.round((hi - lo) / 2) + 1 }, (_, k) => lo + k * 2), true);
    const ref = await corrected(dense, true);
    makeStack(zs, true);
    const got = await corrected(ids, true);
    const gotOld = await corrected(ids, false);
    expect(Math.abs(got.z - ref.z)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(gotOld.z - ref.z)).toBeGreaterThan(0.5);
  });

  it("buildMprVolume: 欠損のあるチルトの結果に grid.interpolated === true と補正のフラグが付く", async () => {
    const ids = makeStack(range(N).filter((_, k) => k !== 11), true);
    const r = await buildMprVolume(ids, "CT", "vol-1");
    expect(r.corrected).toBe(true);
    expect(r.geometry.kind).toBe("missing");
    expect(r.grid).toMatchObject({ interpolated: true, count: N, spacing: expect.closeTo(DZ * Math.cos(TILT), 6) });
    expect(created).toHaveLength(1);
  });

  it("buildMprVolume: 等間隔のチルトには grid が付かない（従来どおり）", async () => {
    const ids = makeStack(range(N), true);
    const r = await buildMprVolume(ids, "CT", "vol-2");
    expect(r.corrected).toBe(true);
    expect(r.grid).toBeUndefined();
  });
});
