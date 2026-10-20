import { describe, expect, it } from "vitest";
import { computeRoiTimeSeries, type RoiTimeSeriesInput } from "./pluginRoiTimeSeriesApi";

const W = 8;
const H = 8;

/** 画素値 = 定数 base。矩形 (x0..x1, y0..y1) の内側だけ inner（画素中心で判定される領域）。 */
function slice(base: number, inner: number, rect: [number, number, number, number]) {
  const v = new Float32Array(W * H).fill(base);
  for (let y = rect[1]; y <= rect[3]; y++) for (let x = rect[0]; x <= rect[2]; x++) v[y * W + x] = inner;
  return { values: v, width: W, height: H, unit: "HU" };
}

/** ROI = 画素 (2,2)〜(3,3) の 2×2 を囲む閉じた矩形。画素 (x,y) の中心は (x+0.5, y+0.5)。 */
const roi = {
  roiUid: "r1",
  tileId: "tile",
  tool: "RectangleROI",
  points: [
    [1.9, 1.9],
    [4.1, 1.9],
    [4.1, 4.1],
    [1.9, 4.1],
  ] as Array<[number, number]>,
  spacing: [1, 1] as [number | null, number | null],
  sliceIndex: 1,
  zScope: 1 as number | "all" | null,
  c: 0,
};

/** imageId = `c{c}t{t}z{z}`。(c,t,z) ごとに領域内の値が違う。 */
function build(over: Partial<RoiTimeSeriesInput> = {}, nT = 3, withTime = true): RoiTimeSeriesInput {
  const read = async (id: string) => {
    const m = /c(\d)t(\d)z(\d)/.exec(id)!;
    const [c, t, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // 領域内 = 100*c + 10*(t+1) + z、領域外 = -1（領域外の画素が混ざると平均が崩れる）
    return slice(-1, 100 * c + 10 * (t + 1) + z, [2, 2, 3, 3]);
  };
  return {
    roi,
    closed: true,
    layout: {
      nT,
      zStack: (c, t) => [0, 1, 2].map((z) => `c${c}t${t}z${z}`),
      timeSecAt: withTime ? (_c, z, t) => 2.5 * t + 0.1 * z : undefined,
      timeSource: withTime ? "AcquisitionTime" : null,
    },
    readSlice: read,
    unitOf: () => "HU",
    ...over,
  };
}

describe("computeRoiTimeSeries", () => {
  it("全時相に同じ領域を当て、平均・画素数・経過秒が既知の値と一致する", async () => {
    const r = await computeRoiTimeSeries(build());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // z=1, c=0: 領域内 = 10*(t+1) + 1
    expect(r.points.map((p) => p.mean)).toEqual([11, 21, 31]);
    expect(r.points.map((p) => p.n)).toEqual([4, 4, 4]);
    expect(r.points.map((p) => p.sd)).toEqual([0, 0, 0]);
    // 秒は ROI のスライス z=1 のセルのもの（スライスごとに違う値が正しく選ばれる）
    expect(r.points.map((p) => p.timeSec)).toEqual([0.1, 2.6, 5.1]);
    expect(r.timeSource).toBe("AcquisitionTime");
    expect(r.unit).toBe("HU");
    expect(r.z).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("別のチャンネル・スライスの値が混ざらない", async () => {
    const r = await computeRoiTimeSeries(build({ roi: { ...roi, c: 1, sliceIndex: 2 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points.map((p) => p.mean)).toEqual([112, 122, 132]);
  });

  it("時刻が無いシリーズでは timeSec が全部 null（秒を作らない）", async () => {
    const r = await computeRoiTimeSeries(build({}, 3, false));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points.map((p) => p.timeSec)).toEqual([null, null, null]);
    expect(r.timeSource).toBeNull();
  });

  it("読めない時相は欠損（0 や隣の値で埋めない）で警告が付く", async () => {
    const base = build();
    const r = await computeRoiTimeSeries({
      ...base,
      readSlice: async (id) => (id.includes("t1") ? null : base.readSlice(id)),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points[1]).toEqual({ t: 1, timeSec: 2.6, mean: null, sd: null, n: 0 });
    expect(r.points[0].mean).toBe(11);
    expect(r.points[2].mean).toBe(31);
    expect(r.warnings).toEqual(["unreadable@1"]);
  });

  it("ROI が画像の外にある時相は欠損と警告（0 にならない）", async () => {
    const outside = {
      ...roi,
      points: [
        [20.5, 20.5],
        [22.5, 20.5],
        [22.5, 22.5],
        [20.5, 22.5],
      ] as Array<[number, number]>,
    };
    const r = await computeRoiTimeSeries(build({ roi: outside }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points.every((p) => p.mean === null && p.n === 0)).toBe(true);
    expect(r.warnings).toContain("no-pixels@0");
    expect(r.warnings).toContain("roi-exceeds-image@0");
  });

  it("画像のすぐ外の細い ROI は端の画素で代表させず欠損にする", async () => {
    // 統計エンジンは「1 画素も入らない ROI」を最寄り画素で代表させ、外は端へ丸める。
    // x ∈ [-0.4, -0.1] は画像の左の外だが、バウンディングボックスが x=0 の列にかかる。
    const left = {
      ...roi,
      points: [
        [-0.4, 2.1],
        [-0.1, 2.1],
        [-0.1, 3.9],
        [-0.4, 3.9],
      ] as Array<[number, number]>,
    };
    const r = await computeRoiTimeSeries(build({ roi: left }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points.every((p) => p.mean === null && p.n === 0)).toBe(true);
    expect(r.warnings).toContain("no-pixels@0");
  });

  it("一部がはみ出す ROI は残りの画素で平均を出し、はみ出しを警告する", async () => {
    const part = {
      ...roi,
      points: [
        [6.1, 2.1],
        [9.5, 2.1],
        [9.5, 3.9],
        [6.1, 3.9],
      ] as Array<[number, number]>,
    };
    const r = await computeRoiTimeSeries(build({ roi: part }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 画像内に残るのは画素 x=6,7 × y=2,3 の 4 つ。領域 (2..3,2..3) の外なので -1
    expect(r.points[0].mean).toBe(-1);
    expect(r.points[0].n).toBe(4);
    expect(r.warnings).toContain("roi-exceeds-image@0");
  });

  it("グローバル ROI・線 ROI・単一時相・シネは失敗する", async () => {
    const g = await computeRoiTimeSeries(build({ roi: { ...roi, zScope: "all" } }));
    expect(g).toMatchObject({ ok: false });
    const line = await computeRoiTimeSeries(build({ roi: { ...roi, tool: "Length" } }));
    expect(line).toMatchObject({ ok: false });
    const single = await computeRoiTimeSeries(build({}, 1));
    expect(single).toMatchObject({ ok: false });
    const b = build();
    const cine = await computeRoiTimeSeries({ ...b, layout: { ...b.layout, stackAxis: "t" } });
    expect(cine).toMatchObject({ ok: false });
  });
});
