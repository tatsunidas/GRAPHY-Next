import { describe, expect, it } from "vitest";
import {
  averageFrames,
  backgroundRms,
  estimateShift,
  needsLogTransform,
  parseFrameNumbers,
  pickMaskFrames,
  shiftBilinear,
  subtractFrames,
} from "./dsa";

/** w×h の画像を作る（f(x,y) で値を決める）。 */
function img(w: number, h: number, f: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f(x, y);
  return out;
}

describe("needsLogTransform — PixelIntensityRelationship", () => {
  it("LIN のときだけ対数変換が要る", () => {
    expect(needsLogTransform("LIN")).toBe(true);
    expect(needsLogTransform("lin")).toBe(true);
    expect(needsLogTransform("LOG")).toBe(false);
  });

  it("記載が無ければ LOG とみなす（XA の慣行）", () => {
    expect(needsLogTransform(null)).toBe(false);
    expect(needsLogTransform(undefined)).toBe(false);
    expect(needsLogTransform("")).toBe(false);
  });
});

describe("averageFrames", () => {
  it("画素ごとの平均", () => {
    const a = Float32Array.from([0, 10, 20]);
    const b = Float32Array.from([10, 20, 30]);
    expect(Array.from(averageFrames([a, b])!)).toEqual([5, 15, 25]);
  });

  it("サイズが違えば null（黙って壊れた画像を作らない）", () => {
    expect(averageFrames([Float32Array.from([1]), Float32Array.from([1, 2])])).toBeNull();
    expect(averageFrames([])).toBeNull();
  });
});

describe("shiftBilinear — サブピクセル平行移動", () => {
  it("整数シフトは値をそのまま移す", () => {
    const src = img(4, 1, (x) => x);          // [0,1,2,3]
    const out = shiftBilinear(src, 4, 1, 1, 0); // 右へ 1
    expect(Array.from(out)).toEqual([0, 0, 1, 2]); // 左端は clamp
  });

  it("0.5px シフトは中間値になる（最近傍で妥協しない）", () => {
    const src = img(4, 1, (x) => x * 10);       // [0,10,20,30]
    const out = shiftBilinear(src, 4, 1, 0.5, 0);
    expect(out[2]).toBeCloseTo(15, 5);
    expect(out[3]).toBeCloseTo(25, 5);
  });

  it("範囲外は端の値で埋める（黒縁を作らない）", () => {
    const src = img(3, 1, () => 7);
    const out = shiftBilinear(src, 3, 1, 2, 0);
    expect(Array.from(out)).toEqual([7, 7, 7]);
  });

  it("シフト 0 は恒等", () => {
    const src = img(3, 3, (x, y) => x * y);
    expect(Array.from(shiftBilinear(src, 3, 3, 0, 0))).toEqual(Array.from(src));
  });

  it("縦方向も同じ規約（dy 正で下へ）", () => {
    const src = img(1, 3, (_x, y) => y);
    expect(Array.from(shiftBilinear(src, 1, 3, 0, 1))).toEqual([0, 0, 1]);
  });
});

describe("subtractFrames — 差分の数式", () => {
  it("LOG（線形差分）: 血管（暗い＝値が小さい）は正になる", () => {
    const mask = img(2, 1, () => 100);
    const live = img(2, 1, (x) => (x === 0 ? 40 : 100)); // x=0 に造影
    const d = subtractFrames(mask, live, 2, 1, { dx: 0, dy: 0, logarithmic: false })!;
    expect(d[0]).toBe(60);
    expect(d[1]).toBe(0);
  });

  it("LIN: 対数を取ってから引く", () => {
    const mask = img(1, 1, () => 100);
    const live = img(1, 1, () => 10);
    const d = subtractFrames(mask, live, 1, 1, { dx: 0, dy: 0, logarithmic: true })!;
    expect(d[0]).toBeCloseTo(Math.log(100.001) - Math.log(10.001), 5);
  });

  it("0 でも対数が発散しない", () => {
    const d = subtractFrames(img(1, 1, () => 0), img(1, 1, () => 0), 1, 1, {
      dx: 0,
      dy: 0,
      logarithmic: true,
    })!;
    expect(Number.isFinite(d[0])).toBe(true);
    expect(d[0]).toBe(0);
  });

  it("マスク側だけをシフトする（体動補正）", () => {
    const mask = img(4, 1, (x) => (x === 1 ? 100 : 0));
    const live = img(4, 1, (x) => (x === 2 ? 100 : 0));
    // マスクを右に 1 ずらせば構造が重なり、差分は 0 になる。
    const d = subtractFrames(mask, live, 4, 1, { dx: 1, dy: 0, logarithmic: false })!;
    expect(d[2]).toBe(0);
  });

  it("サイズ不一致は null", () => {
    expect(subtractFrames(img(2, 1, () => 0), img(3, 1, () => 0), 2, 1, { dx: 0, dy: 0, logarithmic: false })).toBeNull();
  });
});

describe("pickMaskFrames — マスクの自動選択", () => {
  it("造影到達の手前をマスクにする", () => {
    // 0..5 は基線（100 付近）、6 から造影で暗くなる。
    const mean = [100, 100, 101, 99, 100, 100, 70, 50, 45, 60];
    const p = pickMaskFrames(mean);
    expect(p.onset).toBe(6);
    expect(p.frames).toEqual([1, 2, 3, 4, 5]);
  });

  it("マスク枚数の上限を守る", () => {
    const mean = [100, 100, 100, 100, 100, 100, 100, 100, 20];
    const p = pickMaskFrames(mean, 3);
    expect(p.frames).toHaveLength(3);
    expect(p.frames[p.frames.length - 1]).toBe(p.onset! - 1);
  });

  it("造影が見つからなければ末尾側を使う（onset は null）", () => {
    const mean = [100, 100, 100, 100, 100, 100];
    const p = pickMaskFrames(mean);
    expect(p.onset).toBeNull();
    expect(p.frames.length).toBeGreaterThan(0);
  });

  it("基線が完全に平坦でも量子化ノイズで誤検出しない", () => {
    // 全フレーム同値 + 1 だけ 0.1% の揺らぎ。閾値の下限（平均の 0.5%）で弾く。
    const mean = [1000, 1000, 1000, 1000, 1000, 1001, 1000, 1000];
    expect(pickMaskFrames(mean).onset).toBeNull();
  });

  it("空・1 フレームでも壊れない", () => {
    expect(pickMaskFrames([]).frames).toEqual([]);
    expect(pickMaskFrames([5]).frames).toEqual([0]);
  });
});

describe("backgroundRms / estimateShift — ピクセルシフトの評価と自動推定", () => {
  it("完全に一致していれば背景 RMS は 0", () => {
    expect(backgroundRms(new Float32Array(100))).toBe(0);
  });

  it("血管（大きな値の少数画素）は RMS から除外される", () => {
    // 背景 0 に、10% だけ大きな値（血管相当）。
    const d = new Float32Array(100);
    for (let i = 0; i < 10; i++) d[i] = 1000;
    expect(backgroundRms(d, 0.1)).toBeCloseTo(0, 6);
  });

  it("★既知のズレを取り戻せる（整数シフト）", () => {
    const w = 24;
    const h = 24;
    // 背景に構造（骨相当）を置き、live はそれが (2,-1) ずれたもの。
    const pattern = (x: number, y: number) => Math.sin(x * 0.7) * 40 + Math.cos(y * 0.5) * 30 + 100;
    const mask = img(w, h, pattern);
    const live = img(w, h, (x, y) => pattern(x - 2, y + 1));
    const best = estimateShift(mask, live, w, h, false, 4);
    expect(best.dx).toBeCloseTo(2, 1);
    expect(best.dy).toBeCloseTo(-1, 1);
  });

  it("★サブピクセルのズレも 0.2px 以内で当てる", () => {
    const w = 24;
    const h = 24;
    // 横方向だけの縞（サブピクセルの当て込みを x に絞って評価する）。
    const pattern = (x: number) => Math.sin(x * 0.6) * 50 + 120;
    const mask = img(w, h, pattern);
    const live = img(w, h, (x) => pattern(x - 1.5));
    const best = estimateShift(mask, live, w, h, false, 3);
    expect(Math.abs(best.dx - 1.5)).toBeLessThan(0.2);
  });

  it("ズレが無ければ 0 を返す", () => {
    const w = 16;
    const h = 16;
    const same = img(w, h, (x, y) => x + y);
    const best = estimateShift(same, same, w, h, false, 2);
    expect(best.dx).toBe(0);
    expect(best.dy).toBe(0);
    expect(best.rms).toBeCloseTo(0, 6);
  });
});

describe("parseFrameNumbers — DICOM の 1 origin を 0 origin へ", () => {
  it("バックスラッシュ区切りを変換する", () => {
    expect(parseFrameNumbers("1\\2\\3")).toEqual([0, 1, 2]);
  });

  it("空・不正は null", () => {
    expect(parseFrameNumbers(null)).toBeNull();
    expect(parseFrameNumbers("")).toBeNull();
    expect(parseFrameNumbers("abc")).toBeNull();
  });

  it("0 以下は捨てる（1 origin なので 0 は不正）", () => {
    expect(parseFrameNumbers("0\\1\\2")).toEqual([0, 1]);
  });
});
