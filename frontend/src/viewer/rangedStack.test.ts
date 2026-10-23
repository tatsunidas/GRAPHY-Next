import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SeriesLayoutDto } from "../api";
import { imageIdsForLayoutStack } from "./imageId";
import { rangedStackIds } from "./rangedStack";
import { viewer3dCtxKey } from "../viewer3d/viewer3dCtx";

/** 300 枚・1 mm・法線 +z。nC=2 のときは c=1 の SOP 名を別にする。 */
function dto(n = 300, nC = 1, withIpp = true): SeriesLayoutDto {
  const cells = [];
  for (let c = 0; c < nC; c++) for (let z = 0; z < n; z++) cells.push({ c, t: 0, z, sopInstanceUid: `sop-c${c}-z${z}` });
  return {
    nZ: n, nC, nT: 1, cDimension: null, tDimension: null, cells,
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    pixelSpacingRow: 1, pixelSpacingCol: 1, imageWidth: 8, imageHeight: 8,
    zSpatial: withIpp ? Array.from({ length: n }, (_, z) => ({ z, imagePositionPatient: [0, 0, z] })) : null,
    frameOfReferenceUID: null,
  } as unknown as SeriesLayoutDto;
}
// imageId の組み立ては apiBase() を通るので window が要る（node 環境には無い）。
beforeAll(() => { vi.stubGlobal("window", { __GRAPHY_API_BASE__: "http://localhost:8080" }); });

const all = (d: SeriesLayoutDto, c = 0) => imageIdsForLayoutStack(d.cells, "standalone", c, 0, "st", "se");

describe("rangedStackIds", () => {
  it("mm [100,199] は 100 枚で、範囲なしの列の 101〜200 枚目と一致する", () => {
    const d = dto();
    const r = rangedStackIds(d, "standalone", "st", "se", 0, 0, { kind: "mm", fromMm: 100, toMm: 199 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.imageIds).toEqual(all(d).slice(100, 200));
      expect(r.imageIds).toHaveLength(100);
      expect(r.total).toBe(300);
    }
  });
  it("番号（IPP 無し）でも同じ作り方で絞れる", () => {
    const d = dto(300, 1, false);
    const r = rangedStackIds(d, "standalone", "st", "se", 0, 0, { kind: "index", from: 100, to: 199 });
    expect(r.ok && r.imageIds).toEqual(all(d).slice(100, 200));
  });
  it("指定した c の列だけを返す", () => {
    const d = dto(300, 2);
    const r = rangedStackIds(d, "standalone", "st", "se", 1, 0, { kind: "mm", fromMm: 0, toMm: 9 });
    expect(r.ok && r.imageIds).toEqual(all(d, 1).slice(0, 10));
  });
  it("負例: 範囲外・IPP 無しで mm・レイアウト無しは失敗（全体を返さない）", () => {
    expect(rangedStackIds(dto(), "standalone", "st", "se", 0, 0, { kind: "mm", fromMm: 1000, toMm: 2000 })).toEqual({ ok: false, reason: "outOfRange" });
    expect(rangedStackIds(dto(300, 1, false), "standalone", "st", "se", 0, 0, { kind: "mm", fromMm: 0, toMm: 5 })).toEqual({ ok: false, reason: "noIpp" });
    expect(rangedStackIds(null, "standalone", "st", "se", 0, 0, { kind: "index", from: 0, to: 5 })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("viewer3dCtxKey の範囲", () => {
  const base = { study: { studyInstanceUid: "st" }, series: { seriesInstanceUid: "se" }, c: 0, t: 0 };
  it("範囲なしは従来のキーのまま、範囲が違えば別キー", () => {
    expect(viewer3dCtxKey(base)).toBe("st|se|0|0");
    const a = viewer3dCtxKey({ ...base, range: { kind: "mm", fromMm: 100, toMm: 199 } });
    const b = viewer3dCtxKey({ ...base, range: { kind: "mm", fromMm: 100, toMm: 150 } });
    expect(a).not.toBe(viewer3dCtxKey(base));
    expect(a).not.toBe(b);
  });
});
