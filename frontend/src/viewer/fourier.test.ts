/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * フーリエ解析の純関数（`fourier.ts`）。往復・周波数の位置・シフト・マスク・基底の和を固定する。
 */
import { describe, expect, it } from "vitest";
import {
  applyMask,
  basisImage,
  buildMask,
  complexExportSlices,
  cropFromPadded,
  decomposeLine,
  fft2d,
  fftshift,
  isMaskActive,
  isolatedIndices,
  multiplyMask,
  nextPow2,
  normalCdf,
  padToPow2Square,
  project3d,
  radialProfile,
  rectCenterLimit,
  toGray8,
  topComponents,
  unshiftedIndex,
  waveOf,
} from "./fourier";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomImage(n: number, seed = 1): Float64Array {
  const rnd = mulberry32(seed);
  const a = new Float64Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = rnd() * 200 - 50;
  return a;
}

describe("fft2d", () => {
  it("順変換 → 逆変換で元に戻る", () => {
    const n = 16;
    const src = randomImage(n);
    const re = src.slice();
    const im = new Float64Array(n * n);
    fft2d(re, im, n);
    fft2d(re, im, n, true);
    for (let i = 0; i < n * n; i++) {
      expect(Math.abs(re[i] - src[i])).toBeLessThan(1e-9);
      expect(Math.abs(im[i])).toBeLessThan(1e-9);
    }
  });

  it("単一の cos 波は (±u, ±v) にだけピークが立つ", () => {
    const n = 32;
    const fx = 3;
    const fy = 5;
    const re = new Float64Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) re[y * n + x] = Math.cos((2 * Math.PI * (fx * x + fy * y)) / n);
    const im = new Float64Array(n * n);
    fft2d(re, im, n);
    const mag = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) mag[i] = Math.hypot(re[i], im[i]);
    const shifted = fftshift(mag, n);
    const h = n / 2;
    const peaks: number[] = [];
    shifted.forEach((v, i) => {
      if (v > 1) peaks.push(i);
    });
    expect(peaks.sort((a, b) => a - b)).toEqual([(h - fy) * n + (h - fx), (h + fy) * n + (h + fx)]);
    expect(shifted[(h + fy) * n + h + fx]).toBeCloseTo((n * n) / 2, 6);
  });

  it("2 のべき乗以外は拒否する", () => {
    expect(() => fft2d(new Float64Array(9), new Float64Array(9), 3)).toThrow();
  });
});

describe("fftshift", () => {
  it("2 回掛けると元に戻り、DC が中央へ移る", () => {
    const n = 8;
    const a = Float32Array.from({ length: n * n }, (_, i) => i);
    const s = fftshift(a, n);
    expect(s[(n / 2) * n + n / 2]).toBe(0);
    expect(Array.from(fftshift(s, n))).toEqual(Array.from(a));
    expect(unshiftedIndex(n / 2, n / 2, n)).toBe(0);
  });
});

describe("padToPow2Square / cropFromPadded", () => {
  it("平均値で埋め、左上に置き（ImageJ と同じ）、切り戻すと一致する", () => {
    const w = 5;
    const h = 3;
    const vals = Float32Array.from({ length: w * h }, (_, i) => i);
    const p = padToPow2Square(vals, w, h);
    expect(p.n).toBe(8);
    expect(p.mean).toBeCloseTo(7, 9);
    expect([p.offX, p.offY]).toEqual([0, 0]);
    expect(p.data[0]).toBe(0);
    expect(p.data[p.n * p.n - 1]).toBeCloseTo(7, 9);
    expect(Array.from(cropFromPadded(p.data, p.n, p.offX, p.offY, w, h))).toEqual(Array.from(vals));
    expect(nextPow2(512)).toBe(512);
    expect(nextPow2(513)).toBe(1024);
  });
});

describe("toGray8", () => {
  it("丸めて 0〜255 に収める", () => {
    expect(Array.from(toGray8(Float32Array.from([-3, 12.4, 12.6, 300])))).toEqual([0, 12, 13, 255]);
  });
});

describe("buildMask", () => {
  const n = 32;
  const h = n / 2;

  it("円形: σ=0 は階段、∧ と !∧ の和は 1", () => {
    const pass = buildMask({ kind: "circle", radius: 5, mode: "pass" }, n, 0);
    const stop = buildMask({ kind: "circle", radius: 5, mode: "stop" }, n, 0);
    expect(pass[h * n + h]).toBe(1);
    expect(pass[h * n + h + 5]).toBe(1);
    expect(pass[h * n + h + 6]).toBe(0);
    for (let i = 0; i < n * n; i++) expect(pass[i] + stop[i]).toBeCloseTo(1, 9);
  });

  it("ドーナツ: 帯の中だけ通す／σ>0 で縁がなだらかになる", () => {
    const m = buildMask({ kind: "donut", radius: 8, width: 4, mode: "pass" }, n, 0);
    expect(m[h * n + h]).toBe(0);
    expect(m[h * n + h + 8]).toBe(1);
    expect(m[h * n + h + 11]).toBe(0);
    const soft = buildMask({ kind: "donut", radius: 8, width: 4, mode: "pass" }, n, 1.5);
    expect(soft[h * n + h + 11]).toBeGreaterThan(0);
    expect(soft[h * n + h + 11]).toBeLessThan(0.5);
  });

  it("長方形（縦）: 全高で除去し、mirror で DC について点対称", () => {
    const m = buildMask({ kind: "rect", orientation: "vertical", center: 6, width: 3, mirror: true }, n, 0);
    for (let y = 0; y < n; y++) {
      expect(m[y * n + h + 6]).toBe(0);
      expect(m[y * n + h - 6]).toBe(0);
      expect(m[y * n + h]).toBe(1);
    }
    for (let y = 1; y < n; y++)
      for (let x = 1; x < n; x++) expect(m[y * n + x]).toBe(m[(n - y) * n + (n - x)]);
    const single = buildMask({ kind: "rect", orientation: "horizontal", center: 6, width: 3, mirror: false }, n, 0);
    expect(single[(h + 6) * n + 3]).toBe(0);
    expect(single[(h - 6) * n + 3]).toBe(1);
  });

  it("長方形の位置の上限では、帯も枠もスペクトルの内側に収まる", () => {
    for (const width of [1, 3, 4, 10.5]) {
      const lim = rectCenterLimit(n, width);
      for (const center of [lim, -lim]) {
        // 帯が覆う index（シフト後）が 0〜n−1 に収まる
        expect(h + center - width / 2).toBeGreaterThanOrEqual(0);
        expect(h + center + width / 2).toBeLessThanOrEqual(n - 1 + 0.5);
        // 枠（x = n/2 + 0.5 + center ± width/2）が 0〜n に収まる
        expect(h + 0.5 + center - width / 2).toBeGreaterThanOrEqual(0);
        expect(h + 0.5 + center + width / 2).toBeLessThanOrEqual(n);
      }
      // 1 つ外は枠がはみ出す
      expect(h + 0.5 + lim + 1 + width / 2).toBeGreaterThan(n);
    }
    expect(rectCenterLimit(n, 1000)).toBe(0);
  });

  it("normalCdf は既知値に一致する", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe("basisImage", () => {
  it("係数で重み付けした基底を全座標で足すと元画像になる", () => {
    const n = 8;
    const src = randomImage(n, 7);
    const re = src.slice();
    const im = new Float64Array(n * n);
    fft2d(re, im, n);
    const sum = new Float64Array(n * n);
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) {
        const k = unshiftedIndex(u, v, n);
        const b = basisImage(u, v, n, { re: re[k], im: im[k] });
        for (let i = 0; i < n * n; i++) sum[i] += b[i];
      }
    for (let i = 0; i < n * n; i++) expect(sum[i]).toBeCloseTo(src[i], 3);
  });

  it("DC の純粋な基底は定数 1", () => {
    const b = basisImage(4, 4, 8);
    expect(Array.from(b).every((x) => x === 1)).toBe(true);
  });
});

describe("isMaskActive / multiplyMask", () => {
  it("全通過マスクは効いていない扱い、フィルタ後の |Re| はマスク適用後の実部の絶対値と一致する", () => {
    const n = 16;
    expect(isMaskActive(buildMask({ kind: "none" }, n, 0))).toBe(false);
    const mask = buildMask({ kind: "circle", radius: 3, mode: "pass" }, n, 1);
    expect(isMaskActive(mask)).toBe(true);

    const src = randomImage(n, 5);
    const re = src.slice();
    const im = new Float64Array(n * n);
    fft2d(re, im, n);
    const realAbs = fftshift(Float32Array.from(re, Math.abs), n);
    const viaMultiply = multiplyMask(realAbs, mask);
    const masked = applyMask(re, im, n, mask);
    const direct = fftshift(Float32Array.from(masked.re, Math.abs), n);
    for (let i = 0; i < n * n; i++) expect(viaMultiply[i]).toBeCloseTo(direct[i], 2);
    expect(() => multiplyMask(new Float32Array(3), new Float32Array(4))).toThrow();
  });
});

describe("complexExportSlices", () => {
  it("書き出した符号付き Re・Im（Float32）から逆変換すると、元画像に戻る（入れ替えあり／なし）", () => {
    const n = 32;
    const w = 27;
    const hh = 19;
    const rnd = mulberry32(11);
    const vals = Float32Array.from({ length: w * hh }, () => Math.round(rnd() * 4000 - 1000));
    const p = padToPow2Square(vals, w, hh);
    const re = p.data.slice();
    const im = new Float64Array(n * n);
    fft2d(re, im, p.n);
    const reS = fftshift(Float32Array.from(re), n);
    const imS = fftshift(Float32Array.from(im), n);
    for (const shifted of [true, false]) {
      const [eRe, eIm] = complexExportSlices(reS, imS, n, null, shifted);
      // 保存したファイルを読み戻した利用者の手順: （shifted なら）ifftshift → 逆変換 → 切り出し
      const rRe = Float64Array.from(shifted ? fftshift(eRe, n) : eRe);
      const rIm = Float64Array.from(shifted ? fftshift(eIm, n) : eIm);
      fft2d(rRe, rIm, n, true);
      const back = cropFromPadded(rRe, n, p.offX, p.offY, w, hh);
      for (let i = 0; i < vals.length; i++) expect(Math.abs(back[i] - vals[i])).toBeLessThan(0.05);
    }
    // 符号が残っている（絶対値ではない）
    expect(Array.from(reS).some((x) => x < 0)).toBe(true);
    expect(Array.from(imS).some((x) => x < 0)).toBe(true);
  });

  it("マスクがあれば掛かり、フィルタ後の逆変換と一致する", () => {
    const n = 16;
    const src = randomImage(n, 9);
    const re = src.slice();
    const im = new Float64Array(n * n);
    fft2d(re, im, n);
    const mask = buildMask({ kind: "circle", radius: 4, mode: "pass" }, n, 1);
    const [eRe, eIm] = complexExportSlices(fftshift(Float32Array.from(re), n), fftshift(Float32Array.from(im), n), n, mask, false);
    const rRe = Float64Array.from(eRe);
    const rIm = Float64Array.from(eIm);
    fft2d(rRe, rIm, n, true);
    const g = applyMask(re, im, n, mask);
    fft2d(g.re, g.im, n, true);
    for (let i = 0; i < n * n; i++) expect(rRe[i]).toBeCloseTo(g.re[i], 2);
  });
});

describe("applyMask", () => {
  it("全通過マスクなら逆変換で元画像、ローパスで高周波が減る", () => {
    const n = 16;
    const src = randomImage(n, 3);
    const re = src.slice();
    const im = new Float64Array(n * n);
    fft2d(re, im, n);
    const all = applyMask(re, im, n, buildMask({ kind: "none" }, n, 0));
    fft2d(all.re, all.im, n, true);
    for (let i = 0; i < n * n; i++) expect(all.re[i]).toBeCloseTo(src[i], 9);

    const lp = applyMask(re, im, n, buildMask({ kind: "circle", radius: 2, mode: "pass" }, n, 0));
    fft2d(lp.re, lp.im, n, true);
    const variance = (a: ArrayLike<number>) => {
      let m = 0;
      for (let i = 0; i < a.length; i++) m += a[i];
      m /= a.length;
      let s = 0;
      for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
      return s / a.length;
    };
    expect(variance(lp.re)).toBeLessThan(variance(src));
  });
});

describe("radialProfile", () => {
  it("単位とナイキスト: 間隔 0.5 mm なら 1 lp/mm、無ければ 0.5 cycles/px", () => {
    const n = 16;
    const mag = new Float32Array(n * n).fill(1);
    const phys = radialProfile(mag, n, 0.5, 0.5);
    expect(phys.unit).toBe("lp/mm");
    expect(phys.nyquistX).toBeCloseTo(1, 12);
    expect(phys.nyquistY).toBeCloseTo(1, 12);
    const px = radialProfile(mag, n, null, 0.5);
    expect(px.unit).toBe("cycles/px");
    expect(px.nyquistX).toBe(0.5);
    // 一様な |F| の平均は全ビン 1
    for (const m of phys.mean) expect(m).toBeCloseTo(1, 12);
    expect(phys.freq[0]).toBe(0);
    // 最遠のビンは四隅（ナイキストの √2 倍付近）
    expect(phys.freq[phys.freq.length - 1]).toBeGreaterThan(phys.nyquistX * 1.3);
  });

  it("DC だけに値があれば 0 のビンだけが立ち、リングは該当する周波数に出る", () => {
    const n = 32;
    const h = n / 2;
    const dc = new Float32Array(n * n);
    dc[h * n + h] = 100;
    const p = radialProfile(dc, n, null, null);
    expect(p.mean[0]).toBe(100);
    for (let j = 1; j < p.mean.length; j++) expect(p.mean[j]).toBe(0);

    const ring = new Float32Array(n * n);
    for (let v = 0; v < n; v++)
      for (let u = 0; u < n; u++) if (Math.round(Math.hypot(u - h, v - h)) === 8) ring[v * n + u] = 1;
    const r = radialProfile(ring, n, null, null);
    const peak = r.freq[r.mean.indexOf(Math.max(...r.mean))];
    expect(peak).toBeCloseTo(8 / n, 12); // 8 周期 / 32 px = 0.25 cycles/px
  });

  it("マスクを渡すとフィルタ後の平均も返る", () => {
    const n = 16;
    const mag = new Float32Array(n * n).fill(2);
    const mask = buildMask({ kind: "circle", radius: 3, mode: "pass" }, n, 0);
    const p = radialProfile(mag, n, 1, 1, mask);
    expect(p.meanMasked![0]).toBe(2);
    expect(p.meanMasked![p.meanMasked!.length - 1]).toBe(0);
  });
});

describe("decomposeLine / waveOf / topComponents", () => {
  for (const L of [64, 65]) {
    it(`全成分の和が元のラインに一致する（L=${L}）`, () => {
      const rnd = mulberry32(L);
      const line = Float32Array.from({ length: L }, () => rnd() * 300 - 80);
      const comps = decomposeLine(line);
      expect(comps.length).toBe((L >> 1) + 1);
      const sum = new Float64Array(L);
      for (const c of comps) waveOf(c, L).forEach((v, i) => (sum[i] += v));
      for (let i = 0; i < L; i++) expect(sum[i]).toBeCloseTo(line[i], 3);
    });
  }

  it("単一の cos 波は 1 成分・既知の振幅と位相になる", () => {
    const L = 128;
    const line = Float32Array.from({ length: L }, (_, x) => 40 + 7 * Math.cos((2 * Math.PI * 5 * x) / L + 0.6));
    const comps = decomposeLine(line);
    expect(comps[0].amp).toBeCloseTo(40, 4);
    expect(comps[5].amp).toBeCloseTo(7, 4);
    expect(comps[5].phase).toBeCloseTo(0.6, 4);
    for (const c of comps) if (c.k !== 0 && c.k !== 5) expect(c.amp).toBeLessThan(1e-3);
    const top = topComponents(comps, 3);
    expect(top.map((c) => c.k)).toContain(5);
    expect(top.every((c) => c.k > 0)).toBe(true);
    expect(top.map((c) => c.k)).toEqual([...top.map((c) => c.k)].sort((a, b) => a - b));
  });
});

describe("project3d", () => {
  it("回転 0 は恒等（y は上向き＝画面では減る）、yaw 90° で x と z が入れ替わる", () => {
    const p = project3d([0.5, 0.25, 0.75], 0, 0, 100, 200, 150);
    expect(p.x).toBeCloseTo(250, 9);
    expect(p.y).toBeCloseTo(125, 9);
    expect(p.depth).toBeCloseTo(0.75, 9);
    const q = project3d([0.5, 0, 0.75], Math.PI / 2, 0, 100, 0, 0);
    expect(q.x).toBeCloseTo(75, 9); // x' = z
    expect(q.depth).toBeCloseTo(-0.5, 9); // z' = −x
    const r = project3d([0, 1, 0], 0, Math.PI / 2, 1, 0, 0);
    expect(r.depth).toBeCloseTo(1, 9); // 真上から見下ろすと上向きは奥へ
  });
});

describe("isolatedIndices", () => {
  it("両隣が 0 の点だけを返す（線にならない点）", () => {
    expect(isolatedIndices([0, 5, 0, 1, 2, 0, 3])).toEqual([1, 6]);
  });
  it("端の点も、隣が 0 なら孤立とみなす", () => {
    expect(isolatedIndices([7, 0, 0, 7])).toEqual([0, 3]);
  });
  it("連続している系列では空", () => {
    expect(isolatedIndices([1, 2, 3])).toEqual([]);
  });
});
