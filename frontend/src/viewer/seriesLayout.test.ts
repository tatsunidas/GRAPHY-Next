import { beforeAll, describe, expect, it } from "vitest";
import type { SeriesLayoutDto } from "../api";
import { buildLayoutFromDto, DEFAULT_AXES } from "./seriesLayout";
import { imageIdForXaFrame, xaSourceUrlOf } from "./imageId";

// apiBase() は window から backend URL を読む（Electron 用）。node 環境なので空にしておく。
beforeAll(() => {
  (globalThis as { window?: unknown }).window = {};
});

function dto(over: Partial<SeriesLayoutDto>): SeriesLayoutDto {
  return {
    nZ: 1,
    nC: 1,
    nT: 1,
    cDimension: null,
    tDimension: null,
    cells: [{ c: 0, z: 0, t: 0, sopInstanceUid: "1.1", frame: -1 }],
    imageOrientationPatient: null,
    pixelSpacingRow: 0,
    pixelSpacingCol: 0,
    imageWidth: 0,
    imageHeight: 0,
    zSpatial: null,
    frameOfReferenceUID: null,
    ...over,
  } as SeriesLayoutDto;
}

/**
 * 軸の提示とスタック軸（fw/angio-design.md §5.7）。
 *
 * <p>最重要なのは **CT/MR の既定が変わっていないこと**。ここが変わると全モダリティの
 * スライス送り・ThickSlab・Sync がまとめて壊れる。
 */
describe("軸の既定（CT/MR の回帰）", () => {
  it("axes 未指定なら Z/C/T の既定・stackAxis は z", () => {
    const l = buildLayoutFromDto(dto({ nZ: 3, cells: [
      { c: 0, z: 0, t: 0, sopInstanceUid: "1.1", frame: -1 },
      { c: 0, z: 1, t: 0, sopInstanceUid: "1.2", frame: -1 },
      { c: 0, z: 2, t: 0, sopInstanceUid: "1.3", frame: -1 },
    ] }), "standalone", "S", "SE");
    expect(l).not.toBeNull();
    expect(l!.stackAxis).toBe("z");
    expect(l!.axes?.z.label).toBe(DEFAULT_AXES.z.label);
    expect(l!.axes?.z.kind).toBe("slice");
    expect(l!.zStack(0, 0)).toHaveLength(3);
  });

  it("cDimension/tDimension は既定の軸にも副題として乗る", () => {
    const l = buildLayoutFromDto(
      dto({ nC: 2, cDimension: "Echo", tDimension: "Temporal", cells: [
        { c: 0, z: 0, t: 0, sopInstanceUid: "1.1", frame: -1 },
        { c: 1, z: 0, t: 0, sopInstanceUid: "1.2", frame: -1 },
      ] }),
      "standalone",
      "S",
      "SE",
    );
    expect(l!.axes?.c.dim).toBe("Echo");
    expect(l!.axes?.t.dim).toBe("Temporal");
  });
});

describe("XA シネのレイアウト", () => {
  const xa = dto({
    nZ: 1,
    nT: 3,
    cells: [
      { c: 0, z: 0, t: 0, sopInstanceUid: "1.1", frame: 0 },
      { c: 0, z: 0, t: 1, sopInstanceUid: "1.1", frame: 1 },
      { c: 0, z: 0, t: 2, sopInstanceUid: "1.1", frame: 2 },
    ],
    axes: { z: { label: "Run", kind: "run" }, c: null, t: { label: "Frame", kind: "frame" }, stackAxis: "t" },
  });

  it("stackAxis と軸ラベルが引き継がれる", () => {
    const l = buildLayoutFromDto(xa, "standalone", "S", "SE")!;
    expect(l.stackAxis).toBe("t");
    expect(l.axes?.z.label).toBe("Run");
    expect(l.axes?.z.kind).toBe("run");
    expect(l.axes?.t.label).toBe("Frame");
    expect(l.axes?.t.kind).toBe("frame");
  });

  it("tStack がフレーム順の imageId を返す", () => {
    const l = buildLayoutFromDto(xa, "standalone", "S", "SE")!;
    const stack = l.tStack!(0, 0);
    expect(stack).toHaveLength(3);
    // ローダ内フレーム指定（1 origin）。サーバ切り出し /frames/{n}/file にしてはいけない。
    expect(stack[0]).toContain("/api/instances/1.1/file&frame=1");
    expect(stack[2]).toContain("&frame=3");
    expect(stack.some((id) => id.includes("/frames/"))).toBe(false);
  });

  it("全フレームが同じ取得 URL を指す（Part-10 の取得は 1 回で済む）", () => {
    const l = buildLayoutFromDto(xa, "standalone", "S", "SE")!;
    const urls = new Set(l.tStack!(0, 0).map(xaSourceUrlOf));
    expect(urls.size).toBe(1);
  });
});

describe("XA フレームの imageId", () => {
  it("フレーム番号は 1 origin（唯一の +1 地点）", () => {
    expect(imageIdForXaFrame("standalone", "1.2.3", 0)).toMatch(/&frame=1$/);
    expect(imageIdForXaFrame("standalone", "1.2.3", 95)).toMatch(/&frame=96$/);
  });

  it("区切りは & （loader が frame= の直前 1 文字を落とすため 1 文字必要）", () => {
    const id = imageIdForXaFrame("standalone", "1.2.3", 4);
    expect(id).toContain("file&frame=5");
    // 剥がした結果が元の取得 URL に戻ること。
    expect(xaSourceUrlOf(id)).toMatch(/\/api\/instances\/1\.2\.3\/file$/);
    expect(xaSourceUrlOf(id)).not.toContain("frame=");
  });

  it("web モードは study/series を含む BFF の URL になる", () => {
    const id = imageIdForXaFrame("web", "1.2.3", 0, "ST", "SE");
    expect(id).toContain("/api/studies/ST/series/SE/instances/1.2.3/file&frame=1");
  });

  it("負のフレームでも 1 未満にならない", () => {
    expect(imageIdForXaFrame("standalone", "1.2.3", -3)).toMatch(/&frame=1$/);
  });
});
