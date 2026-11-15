import { beforeEach, describe, expect, it, vi } from "vitest";

/** imageId → { z, value }。各スライスは 1 値で埋めた 2×2 画像（値でどのスライスの内容か分かる）。 */
const slices = new Map<string, { z: number; value: number }>();
let tilt = false;
vi.mock("@cornerstonejs/core", () => ({
  imageLoader: { loadAndCacheImage: vi.fn(async () => ({})) },
  metaData: {
    get: (module: string, id: string) => {
      const s = slices.get(id);
      if (module === "imagePlaneModule" && s) {
        return {
          imageOrientationPatient: tilt ? [1, 0, 0, 0, Math.cos(0.26), Math.sin(0.26)] : [1, 0, 0, 0, 1, 0],
          imagePositionPatient: [0, 0, s.z], columns: 2, rows: 2, pixelSpacing: [0.9, 0.6],
        };
      }
      return {};
    },
  },
  cache: { getImage: (id: string) => ({ getPixelData: () => new Int16Array(4).fill(slices.get(id)!.value), preScale: { scaled: true } }) },
}));

import { SliceDuplicatesError } from "../viewer/depthVolume";
import { buildDicomResliceVolume } from "./curvedMprVolume";

async function build(zs: number[]) {
  slices.clear();
  const ids = zs.map((z, i) => { const id = `img:${i}`; slices.set(id, { z, value: 100 + i * 10 }); return id; });
  return buildDicomResliceVolume(ids);
}
const range = (n: number, d = 2.5) => Array.from({ length: n }, (_, k) => k * d);
const layer = (v: { data: ArrayLike<number> }, k: number) => v.data[k * 4];

describe("buildDicomResliceVolume", () => {
  beforeEach(() => { tilt = false; });

  it("等間隔は従来どおり（層数 = 枚数、spacing[2] = IPP 間隔、origin = 先頭の IPP、注記なし）", async () => {
    const r = (await build(range(20)))!;
    expect(r.volume.dimensions).toEqual([2, 2, 20]);
    expect(r.volume.spacing[2]).toBeCloseTo(2.5, 9);
    expect(r.volume.origin).toEqual([0, 0, 0]);
    expect(r.depthNote).toBeNull();
    expect(layer(r.volume, 7)).toBe(170);
  });
  it("間隔の 0.5% の揺らぎは等間隔として従来どおり", async () => {
    const r = (await build(range(20).map((z, k) => z + (k % 2 ? 0.005 : -0.005) * 2.5)))!;
    expect(r.volume.dimensions[2]).toBe(20);
    expect(r.depthNote).toBeNull();
  });
  it("2 枚未満は null（従来どおり）", async () => {
    expect(await build([0])).toBeNull();
  });
  it("1 枚欠損: 層数 = 格子、spacing[2] = 最小間隔、元スライスはそのまま、欠けた層は前後の線形補間", async () => {
    const zs = range(20).filter((_, k) => k !== 10); // 19 枚。z = 25 が欠ける
    const r = (await build(zs))!;
    expect(r.volume.dimensions[2]).toBe(20);
    expect(r.volume.spacing[2]).toBeCloseTo(2.5, 9);
    expect(r.depthNote).toEqual({ id: "missing", n: 1 });
    // 層 k の z = origin + k·間隔。各層は元スライスの位置か、その間（半間隔以内に前後の元スライスがある）
    const orig = zs;
    for (let k = 0; k < 20; k++) {
      const z = r.volume.origin[2] + k * r.volume.spacing[2];
      const nearest = Math.min(...orig.map((o) => Math.abs(o - z)));
      expect(nearest).toBeLessThanOrEqual(2.5 + 1e-9);
    }
    expect(layer(r.volume, 9)).toBe(190); // 欠けより前の元スライスは層 k にそのまま載る
    expect(layer(r.volume, 11)).toBe(200); // 欠けより後ろは、配列の 10 番目の元スライスが層 11 に載る
    expect(layer(r.volume, 10)).toBe(Math.round((layer(r.volume, 9) + layer(r.volume, 11)) / 2));
    // 位置: 欠けより後ろの層の z は元スライスの z に一致（平均間隔 2.5 × 19/18 の誤差が出ない）
    expect(r.volume.origin[2] + 11 * r.volume.spacing[2]).toBeCloseTo(zs[10], 9);
  });
  it("不等間隔: 層数 = 格子（最小間隔 2.0 mm）、各元スライスの z が最寄りの層に 1 層以内で載る", async () => {
    const zs = [0]; const pat = [2, 3.5, 2.5, 3];
    for (let k = 0; k < 19; k++) zs.push(zs[k] + pat[k % 4]);
    const r = (await build(zs))!;
    const sp = r.volume.spacing[2];
    expect(sp).toBeCloseTo(2, 9);
    expect(r.volume.dimensions[2]).toBe(Math.round((zs[19] - zs[0]) / 2) + 1);
    expect(r.depthNote?.id).toBe("irregular");
    zs.forEach((z, i) => {
      const k = Math.round((z - r.volume.origin[2]) / sp);
      expect(Math.abs(r.volume.origin[2] + k * sp - z)).toBeLessThanOrEqual(sp / 2 + 1e-9);
      expect(layer(r.volume, k)).toBe(100 + i * 10); // 元スライスは最寄りの層にそのまま載る
    });
  });
  it("重複は SliceDuplicatesError（null にしない）", async () => {
    const zs = range(20); zs.splice(5, 0, zs[5]);
    await expect(build(zs)).rejects.toBeInstanceOf(SliceDuplicatesError);
  });
  it("チルト＋等間隔は従来どおり（spacing[2] = IPP 間隔）", async () => {
    tilt = true;
    const r = (await build(range(10)))!;
    expect(r.volume.dimensions[2]).toBe(10);
    expect(r.volume.spacing[2]).toBeCloseTo(2.5, 9);
  });
});
