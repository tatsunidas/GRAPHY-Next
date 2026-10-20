import { describe, expect, it } from "vitest";
import { buildSyntheticVolume, edgeSpan, findBlobs, hardwareRow, judge, type Expected, type SelfTestRow } from "./render3dSelfTest";

const W = 256;
const H = 256;

type Rect = [number, number, number, number]; // x0, x1, y0, y1（両端含む）
function paint(rects: Rect[]): Uint8Array {
  const buf = new Uint8Array(W * H * 4);
  for (const [x0, x1, y0, y1] of rects) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = (y * W + x) * 4;
        buf[o] = buf[o + 1] = buf[o + 2] = 255;
        buf[o + 3] = 255;
      }
    }
  }
  return buf;
}
const mirror = (rects: Rect[]): Rect[] => rects.map(([a, b, c, d]) => [W - 1 - b, W - 1 - a, c, d]);

// mm: 基準 24×60（比 0.4）、中心間距離 36 mm（幅の 1.5 倍）
const EXP: Expected = { refWidthMm: 24, refHeightMm: 60, centerDistMm: 36 };
// px: 基準 40×100（中心 x=39.5）、目印 12 幅（中心 x=99.5）→ 距離 60 px = 幅の 1.5 倍
const REF: Rect = [20, 59, 50, 149];
const MARK: Rect = [94, 105, 80, 119];

const status = (rows: SelfTestRow[], id: string) => rows.find((r) => r.id === id)?.status;
const run = (rects: Rect[], exp = EXP) => {
  const buf = paint(rects);
  return judge(findBlobs(buf, W, H), exp, { rgba: buf, w: W, h: H });
};

describe("findBlobs", () => {
  it("2 つの離れた矩形を面積順に分ける", () => {
    const b = findBlobs(paint([REF, MARK]), W, H);
    expect(b).toHaveLength(2);
    expect(b[0].area).toBe(40 * 100);
    expect(b[0].minX).toBe(20);
    expect(b[0].maxY).toBe(149);
    expect(b[1].cx).toBeCloseTo(99.5);
  });
  it("背景しきい値以下は拾わない", () => {
    const buf = new Uint8Array(W * H * 4).fill(60);
    expect(findBlobs(buf, W, H)).toHaveLength(0);
  });
});

describe("judge 正例", () => {
  it("向き・画素間隔・距離比がすべて合格", () => {
    const rows = run([REF, MARK]);
    for (const id of ["render", "orientation", "spacing", "distance"]) expect(status(rows, id)).toBe("pass");
  });
});

describe("judge 負例", () => {
  it("左右反転では向きだけが失敗", () => {
    const rows = run(mirror([REF, MARK]));
    expect(status(rows, "orientation")).toBe("fail");
    expect(status(rows, "render")).toBe("pass");
    expect(status(rows, "spacing")).toBe("pass");
    expect(status(rows, "distance")).toBe("pass");
  });
  it("縦を 1/2.5 に潰すと画素間隔が失敗（向き・距離比は合格）", () => {
    const rows = run([[20, 59, 50, 89], [94, 105, 60, 79]]);
    expect(status(rows, "spacing")).toBe("fail");
    expect(status(rows, "orientation")).toBe("pass");
    expect(status(rows, "distance")).toBe("pass");
  });
  it("全面黒では描画が失敗し、後続は未実施（合格が 1 つも無い）", () => {
    const rows = run([]);
    expect(status(rows, "render")).toBe("fail");
    for (const id of ["orientation", "spacing", "distance"]) expect(status(rows, id)).toBe("pending");
    expect(rows.filter((r) => r.status === "pass")).toHaveLength(0);
  });
  it("目印が見つからなければ向きと距離比は失敗", () => {
    const rows = run([REF]);
    expect(status(rows, "orientation")).toBe("fail");
    expect(status(rows, "distance")).toBe("fail");
    expect(status(rows, "spacing")).toBe("pass");
  });
  it("右下に向きのキューブ大の像が増えると、向きと距離比は失敗（目印と取り違えない）", () => {
    const rows = run([REF, MARK, [220, 245, 220, 245]]);
    expect(status(rows, "orientation")).toBe("fail");
    expect(status(rows, "distance")).toBe("fail");
    expect(rows.find((r) => r.id === "orientation")?.reason).toBe("extraBlobs");
  });
  it("距離比がずれると距離比が失敗", () => {
    const rows = run([REF, [150, 161, 80, 119]]);
    expect(status(rows, "distance")).toBe("fail");
    expect(status(rows, "orientation")).toBe("pass");
  });
  it("基準の短辺が 40 px 未満なら画素間隔と距離比は未実施", () => {
    const rows = run([[20, 49, 50, 124], [94, 105, 80, 99]]);
    expect(status(rows, "render")).toBe("pass");
    expect(status(rows, "orientation")).toBe("pass");
    expect(status(rows, "spacing")).toBe("pending");
    expect(status(rows, "distance")).toBe("pending");
  });
});

describe("judge 境界（許容幅 2/s、s=40 → 0.05）", () => {
  // px の縦横比は 40/100=0.4。mm 比をずらして相対差を作る。
  it("ちょうど 5% は合格", () => {
    const rows = run([REF, MARK], { refWidthMm: 40, refHeightMm: 105, centerDistMm: 60 });
    expect(status(rows, "spacing")).toBe("pass");
  });
  it("5% を超えると失敗", () => {
    const rows = run([REF, MARK], { refWidthMm: 40, refHeightMm: 107, centerDistMm: 60 });
    expect(status(rows, "spacing")).toBe("fail");
  });
});

describe("buildSyntheticVolume", () => {
  it("期待値（mm）がボクセル数×spacing と一致する", () => {
    const v = buildSyntheticVolume();
    const dims = v.imageData.getDimensions() as number[];
    const sp = v.imageData.getSpacing() as number[];
    const data = v.imageData.getPointData().getScalars().getData() as Float32Array;
    // 基準の中心を通る行（j,k 固定）の X 方向、列（i,j 固定）の Z 方向を数える
    const j = 64;
    const k = 40;
    let nx = 0;
    for (let i = 0; i < 70; i++) if (data[(k * dims[1] + j) * dims[0] + i] > 0) nx++;
    let nz = 0;
    for (let kk = 0; kk < dims[2]; kk++) if (data[(kk * dims[1] + j) * dims[0] + 44] > 0) nz++;
    expect(nx * sp[0]).toBeCloseTo(v.expected.refWidthMm);
    expect(nz * sp[2]).toBeCloseTo(v.expected.refHeightMm);
    expect(v.expected.centerDistMm).toBe(58);
    expect(sp).toEqual([1, 1, 2.5]);
  });
});

describe("hardwareRow（描画環境の判定を写す）", () => {
  it("GPU で描いていれば合格", () => {
    expect(hardwareRow("hardware")).toMatchObject({ status: "pass", reason: "hardwareYes" });
  });
  it("ソフトウェア描画なら失敗", () => {
    expect(hardwareRow("software")).toMatchObject({ status: "fail", reason: "softwareRender" });
  });
  it("判定できなければ未実施（合格にしない）", () => {
    expect(hardwareRow("unknown")).toMatchObject({ status: "pending", reason: "kindUnknown" });
  });
});

/** 縁を幅 2R の直線でぼかした箱（境界 x0-0.5・x1+0.5 でちょうど半値。補間で描いた縁を模す）。 */
function paintBlurred(rects: Rect[], R: number): Uint8Array {
  const buf = new Uint8Array(W * H * 4);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (const [x0, x1, y0, y1] of rects) {
        const fx = clamp(0.5 + Math.min(x - (x0 - 0.5), x1 + 0.5 - x) / (2 * R));
        const fy = clamp(0.5 + Math.min(y - (y0 - 0.5), y1 + 0.5 - y) / (2 * R));
        v = Math.max(v, Math.min(fx, fy));
      }
      const o = (y * W + x) * 4;
      buf[o] = buf[o + 1] = buf[o + 2] = Math.round(255 * v);
      buf[o + 3] = 255;
    }
  }
  return buf;
}

describe("半値幅（縁のぼけに左右されない幅）", () => {
  it("ぼけた縁でも、半値幅は真の幅に 0.05 px 以内で合う", () => {
    const buf = paintBlurred([REF], 5);
    const y = 100;
    const row = Array.from({ length: W }, (_, x) => buf[(y * W + x) * 4]);
    const span = edgeSpan(row, 0, W - 1)!;
    expect(Math.abs(span.width - 40)).toBeLessThan(0.05);
    expect(Math.abs(span.start - 19.5)).toBeLessThan(0.05);
  });
  it("ぼけた縁でも、正しい比なら画素間隔と距離比は合格（外接矩形だと縁の分だけ広く測って失敗する）", () => {
    const buf = paintBlurred([REF, MARK], 5);
    const blobs = findBlobs(buf, W, H);
    // 前提: 外接矩形は背景の閾値までの縁を含み、真の幅 40 より広い（この差で旧実装は失敗していた）
    expect(blobs[0].maxX - blobs[0].minX + 1).toBeGreaterThanOrEqual(44);
    const rows = judge(blobs, EXP, { rgba: buf, w: W, h: H });
    expect(status(rows, "spacing")).toBe("pass");
    expect(status(rows, "distance")).toBe("pass");
  });
  it("ぼけた縁でも、距離がずれていれば距離比は失敗", () => {
    const buf = paintBlurred([REF, [150, 161, 80, 119]], 5);
    const rows = judge(findBlobs(buf, W, H), EXP, { rgba: buf, w: W, h: H });
    expect(status(rows, "distance")).toBe("fail");
  });
});
