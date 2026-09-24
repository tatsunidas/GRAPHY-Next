import { describe, expect, it } from "vitest";
import {
  classifyMaskSource,
  contrastBounds,
  contrastMask,
  matchByBackground,
  packGradients,
  temporalMedian,
  znccMasked,
  type PhaseMatchFrames,
} from "./xaPhaseMatch";

/* ------------------------------------------------------------------ */
/* §6.16 — 背景の突き合わせで同位相マスクを決める                        */
/* ------------------------------------------------------------------ */

const W = 64;
const H = 48;
const PLANES = 2;

/** 決定性のある擬似乱数（実行ごとに数値が変わるとテストが意味を失う）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 心臓に見立てた「背景」を `shift` px 動かした 2ch 像を作る。
 * 値そのものに意味は無いので、勾配成分の代わりに向きの違う 2 枚を入れてある。
 */
function scene(shift: number, seed: number): Float32Array {
  const rng = mulberry32(seed);
  const out = new Float32Array(PLANES * W * H);
  for (let p = 0; p < PLANES; p++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x - shift;
        const v = p === 0
          ? 40 * Math.sin((u * 2 * Math.PI) / 17) + 25 * Math.cos((y * 2 * Math.PI) / 13)
          : 30 * Math.cos((u * 2 * Math.PI) / 11) * Math.sin((y * 2 * Math.PI) / 19);
        out[(p * H + y) * W + x] = v + 0.5 * (rng() - 0.5);
      }
    }
  }
  return out;
}

function pack(shifts: readonly number[], seedBase = 100): PhaseMatchFrames {
  const per = PLANES * W * H;
  const data = new Float32Array(shifts.length * per);
  shifts.forEach((s, i) => data.set(scene(s, seedBase + i), i * per));
  return { data, width: W, height: H, planes: PLANES, frameCount: shifts.length };
}

const FULL = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };

describe("znccMasked — 除外した画素を本当に無視する", () => {
  it("★ 同じ像どうしなら 1 に近い", () => {
    const f = pack([0, 0]);
    expect(znccMasked(f, 0, 1, FULL, null)).toBeGreaterThan(0.99);
  });

  it("🔴 ★ 除外した領域をいくら壊しても値が変わらない", () => {
    // **これが除外マスクの契約そのもの。** 造影で変わった画素を「見ない」ことを保証する。
    const f = pack([0, 0]);
    const include = new Uint8Array(W * H).fill(1);
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) include[y * W + x] = 0;
    const before = znccMasked(f, 0, 1, FULL, include);

    const per = PLANES * W * H;
    for (let p = 0; p < PLANES; p++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < 20; x++) f.data[per + (p * H + y) * W + x] = 9999;
      }
    }
    expect(znccMasked(f, 0, 1, FULL, include)).toBeCloseTo(before, 10);
    // 除外しなければ当然壊れる（テストが空回りしていないことの確認）。
    expect(znccMasked(f, 0, 1, FULL, null)).toBeLessThan(0.5);
  });

  it("★ 比べる画素が少なすぎたら 0 を返す（当てにならない値を返さない）", () => {
    const f = pack([0, 0]);
    const include = new Uint8Array(W * H);
    for (let i = 0; i < 50; i++) include[i] = 1;
    expect(znccMasked(f, 0, 1, FULL, include, 200)).toBe(0);
  });
});

describe("matchByBackground — 位相の合うマスクを選ぶ", () => {
  // マスク側: −3..+3px を往復する 7 枚（造影前）。
  const MASK_SHIFTS = [0, 1, 2, 3, 2, 1, 0, -1, -2, -3, -2, -1];
  // ライブ側: 同じ動きの続き。**正解は同じ変位を持つマスクフレーム**。
  const LIVE_SHIFTS = [3, 1, -2, -3, 0, 2];

  const frames = pack([...MASK_SHIFTS, ...LIVE_SHIFTS]);
  const maskIdx = MASK_SHIFTS.map((_, i) => i);
  const liveIdx = LIVE_SHIFTS.map((_, i) => MASK_SHIFTS.length + i);

  it("🔴 ★ 変位の一致するマスクフレームを当てる", () => {
    const out = matchByBackground(frames, liveIdx, maskIdx, FULL, () => null);
    expect(out).toHaveLength(liveIdx.length);
    out.forEach((e, i) => {
      expect(e.maskFrame).not.toBeNull();
      expect(MASK_SHIFTS[e.maskFrame!]).toBe(LIVE_SHIFTS[i]);
      expect(e.score).toBeGreaterThan(0.9);
    });
  });

  it("🔴 ★ 造影に相当する領域を除外しないと選択が壊れる", () => {
    // **除外が飾りでないことの錠。** ライブ側の一部を「造影で真っ黒」にして、
    // 除外しなければ間違え、除外すれば当たることを見る。
    const per = PLANES * W * H;
    const contaminated = { ...frames, data: Float32Array.from(frames.data) };
    const vessel = new Uint8Array(W * H);
    for (let y = 10; y < 38; y++) for (let x = 10; x < 50; x++) vessel[y * W + x] = 1;
    for (const t of liveIdx) {
      for (let p = 0; p < PLANES; p++) {
        for (let i = 0; i < W * H; i++) {
          if (vessel[i]) contaminated.data[t * per + p * W * H + i] = -500;
        }
      }
    }

    const without = matchByBackground(contaminated, liveIdx, maskIdx, FULL, () => null);
    const withMask = matchByBackground(contaminated, liveIdx, maskIdx, FULL, () => vessel);

    const hit = (r: ReturnType<typeof matchByBackground>) =>
      r.filter((e, i) => e.maskFrame != null && MASK_SHIFTS[e.maskFrame] === LIVE_SHIFTS[i]).length;

    expect(hit(withMask)).toBe(liveIdx.length);
    expect(hit(without)).toBeLessThan(liveIdx.length);
  });

  it("★ 除外が多すぎるフレームは当てずに null を返す", () => {
    const most = new Uint8Array(W * H).fill(1);
    for (let i = 0; i < W * H * 0.2; i++) most[i] = 0; // 8 割を除外
    const out = matchByBackground(frames, liveIdx, maskIdx, FULL, () => most, { minUsedFraction: 0.5 });
    for (const e of out) {
      expect(e.maskFrame).toBeNull();
      expect(e.usedFraction).toBeLessThan(0.5);
    }
  });

  it("★ margin が「どれでもよかった」を教える", () => {
    // 全部同じ像なら、どのマスクを選んでも同じ＝ margin ≈ 0。
    const flat = pack([0, 0, 0, 0, 0]);
    const out = matchByBackground(flat, [4], [0, 1, 2, 3], FULL, () => null);
    expect(out[0].maskFrame).not.toBeNull();
    expect(out[0].margin).toBeLessThan(0.01);

    // 動きがあれば margin は立つ。
    const real = matchByBackground(frames, [liveIdx[0]], maskIdx, FULL, () => null);
    expect(real[0].margin).toBeGreaterThan(0.01);
  });
});

describe("contrastMask — 造影で変わった画素を拾う", () => {
  const w = 40;
  const h = 30;
  const base = () => Float32Array.from({ length: w * h }, () => 1000);

  it("🔴 ★ 暗くなった領域だけを拾う（明るくなった領域は拾わない）", () => {
    const mask = base();
    const frame = base();
    // 造影＝暗くなる。ここだけ拾ってほしい。
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) frame[y * w + x] = 700;
    // 明るくなる領域は造影ではない（露出の揺れなど）。
    for (let y = 20; y < 25; y++) for (let x = 20; x < 30; x++) frame[y * w + x] = 1300;

    const { exclude, fraction } = contrastMask(mask, frame, w, h, false);
    expect(exclude[10 * w + 10]).toBe(1);
    expect(exclude[22 * w + 25]).toBe(0);
    expect(exclude[0]).toBe(0);
    expect(fraction).toBeGreaterThan(0.05);
    expect(fraction).toBeLessThan(0.2);
  });

  it("★ 差が無ければ何も拾わない", () => {
    const mask = base();
    const frame = base();
    // わずかなノイズだけ（床の自己較正で吸収されること）。
    for (let i = 0; i < frame.length; i++) frame[i] += (i % 7) - 3;
    expect(contrastMask(mask, frame, w, h, false).fraction).toBeLessThan(0.02);
  });

  it("🚨 視野の外（値 0）は数えない", () => {
    // コリメータ外の 1 カウント画素が対数域で桁違いの差を作る問題（§6.10.2）。
    const mask = base();
    const frame = base();
    for (let i = 0; i < 200; i++) { mask[i] = 0; frame[i] = 0; }
    const { exclude } = contrastMask(mask, frame, w, h, true);
    for (let i = 0; i < 200; i++) expect(exclude[i]).toBe(0);
  });
});

describe("contrastBounds — 突き合わせの窓", () => {
  const w = 60;
  const h = 40;

  it("★ 造影が現れた範囲を少し広げて返す", () => {
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    a[10 * w + 20] = 1;
    b[25 * w + 35] = 1;
    const r = contrastBounds([a, b], w, h, 5)!;
    expect(r.x0).toBe(15);
    expect(r.y0).toBe(5);
    expect(r.x1).toBe(40);
    expect(r.y1).toBe(30);
  });

  it("★ 画像の外へはみ出さない", () => {
    const a = new Uint8Array(w * h);
    a[0] = 1;
    a[(h - 1) * w + (w - 1)] = 1;
    const r = contrastBounds([a], w, h, 20)!;
    expect(r.x0).toBe(0);
    expect(r.y0).toBe(0);
    expect(r.x1).toBe(w - 1);
    expect(r.y1).toBe(h - 1);
  });

  it("★ 造影がどこにも無ければ null（窓を決められないと言う）", () => {
    expect(contrastBounds([new Uint8Array(w * h)], w, h)).toBeNull();
  });
});

describe("packGradients — 勾配成分 2ch に詰める", () => {
  it("★ 平坦な像の勾配は 0", () => {
    const f = Float32Array.from({ length: 16 * 12 }, () => 500);
    const p = packGradients([f], 16, 12);
    expect(p.planes).toBe(2);
    expect(p.frameCount).toBe(1);
    expect(Math.max(...p.data)).toBeCloseTo(0, 6);
  });

  it("🔴 ★ 勾配「強度」ではなく成分（符号が残る）", () => {
    // §6.7.2: 強度 |∇I| は非線形でサブピクセルが崩れる（0.26px 対 0.07px）。
    // 左右で逆向きの傾きを作り、**符号が残る**ことを確かめる。
    const w = 16;
    const h = 12;
    const f = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] = x < w / 2 ? x * 10 : (w - x) * 10;
    const p = packGradients([f], w, h);
    const gx = (x: number, y: number) => p.data[y * w + x];
    expect(gx(4, 6)).toBeGreaterThan(0);
    expect(gx(12, 6)).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* §6.19 — 造影前があるのか、造影後しか無いのかを判別する               */
/*                                                                      */
/* 🚨 preContrast.length < 8 で判断してはいけない。あれは推論であって   */
/*    判別ではない——detectOnsetFromSignal は「ランが造影前から始まる」  */
/*    前提の検出器なので、最初から造影が入っていると出力が当てにならない。*/
/* ------------------------------------------------------------------ */

describe("classifyMaskSource — マスク源の判別", () => {
  /** 低→高→低（造影前あり）。実測 CASE01 00000003 の形。 */
  const withPre = (): number[] => [
    ...Array(20).fill(0.006), // 造影前（実測 0.4〜1.9%）
    0.012, 0.020, 0.030,      // 立ち上がり
    ...Array(20).fill(0.056), // ピーク（実測 5.6%）
    0.030, 0.020,             // 洗い出し
    ...Array(10).fill(0.014), // 末尾（実測 1.2〜2.0%）
  ];
  /** 高→低（最初から造影が入っている）。 */
  const onlyPost = (): number[] => [
    ...Array(24).fill(0.056), // 最初からピーク
    0.030, 0.020,
    ...Array(14).fill(0.012), // washout
  ];

  it("🔴 ★ 低→高→低なら preContrast で、**先頭側**を選ぶ", () => {
    const r = classifyMaskSource(withPre());
    expect(r.kind).toBe("preContrast");
    expect(r.frames[0]).toBe(0);
    expect(r.frames.length).toBeGreaterThanOrEqual(20);
    // 末尾は選ばない（造影前があるなら混ぜない）。
    expect(Math.max(...r.frames)).toBeLessThan(23);
  });

  it("🔴 ★ 高→低なら washout で、**末尾側**を選ぶ", () => {
    const f = onlyPost();
    const r = classifyMaskSource(f);
    expect(r.kind).toBe("washout");
    expect(Math.max(...r.frames)).toBe(f.length - 1);
    expect(r.frames.length).toBeGreaterThanOrEqual(8);
    // 🚨 **ピークより前を選ばない。** 立ち上がりと取り違えない。
    expect(Math.min(...r.frames)).toBeGreaterThan(r.evidence.peakFrame);
  });

  it("🔴 ★ 立ち上がりの低い区間を washout と取り違えない", () => {
    // 造影前がある形を washout として解釈すると、先頭が選ばれてしまう。
    const r = classifyMaskSource(withPre());
    expect(r.kind).not.toBe("washout");
  });

  it("★ ずっと造影が入ったままなら none で降りる（無理に当てない）", () => {
    const flat = Array(40).fill(0.05);
    const r = classifyMaskSource(flat);
    expect(r.kind).toBe("none");
    expect(r.frames).toEqual([]);
  });

  it("★ 造影がそもそも無ければ none", () => {
    expect(classifyMaskSource(Array(40).fill(0)).kind).toBe("none");
  });

  it("★ 層が短すぎれば採らない", () => {
    // washout が 3 枚しか無い。
    const f = [...Array(30).fill(0.05), ...Array(3).fill(0.01)];
    expect(classifyMaskSource(f, { minFrames: 8 }).kind).toBe("none");
  });

  it("🔴 ★ 境界: 先頭がピークの何割までを『造影前あり』と呼ぶか", () => {
    // 実測（CASE01 00000003）は 先頭 0.56% / ピーク 5.64% = 0.099。既定の閾値 0.3 に対し十分低い。
    const peak = 0.056;
    const at = (ratio: number) =>
      classifyMaskSource([...Array(20).fill(peak * ratio), ...Array(20).fill(peak),
                          ...Array(10).fill(peak * 0.25)]).kind;
    expect(at(0.099)).toBe("preContrast"); // 実測の値
    expect(at(0.25)).toBe("preContrast");  // 閾値の内側
    expect(at(0.5)).toBe("washout");       // 閾値の外側 → 造影前とは呼ばない
    expect(at(0.9)).toBe("washout");       // ほぼ最初から造影
  });

  it("🚨 ★ 先頭 1 枚の跳ねで造影前を見失わない（実測で踏んだ）", () => {
    // CASE01 00000003 の実測: 先頭の水準は 0.56%（ピークの 10%）で明らかに造影前なのに、
    // **f0 だけが 1.89%** と跳ねていた。閾値は 0.3 × 5.64% = 1.69% なので、
    // 「フレーム 0 から連続で閾値以下」という条件は **1 枚目で切れて** 造影前 0 枚と誤判定した。
    const f = withPre();
    f[0] = 0.019; // 閾値 0.0168 をわずかに超える跳ね
    const r = classifyMaskSource(f);
    expect(r.kind).toBe("preContrast");
    expect(r.frames.length).toBeGreaterThanOrEqual(15);
  });

  it("🚨 ★ washout 層も単発の跳ねで切らない", () => {
    const f = onlyPost();
    f[f.length - 4] = 0.05; // 末尾近くに 1 枚だけ跳ね
    const r = classifyMaskSource(f);
    expect(r.kind).toBe("washout");
    expect(r.frames.length).toBeGreaterThanOrEqual(8);
  });

  it("★ ただし持続して上がっていれば境界は動く（跳ねと本物を取り違えない）", () => {
    const f = withPre();
    // 5 枚続けて閾値を超えたら、そこが境界。
    for (let i = 8; i < 13; i++) f[i] = 0.05;
    const r = classifyMaskSource(f);
    expect(r.kind).toBe("preContrast");
    expect(r.frames.length).toBe(8);
  });

  it("🔴 ★ evidence が時系列と合っている（画面に出す値なので嘘をつかせない）", () => {
    const f = withPre();
    const r = classifyMaskSource(f);
    expect(r.evidence.peakLevel).toBeCloseTo(0.056, 6);
    expect(f[r.evidence.peakFrame]).toBeCloseTo(r.evidence.peakLevel, 6);
    expect(r.evidence.leadingLevel).toBeCloseTo(0.006, 6);
    expect(r.evidence.trailingLevel).toBeCloseTo(0.014, 6);
  });
});

describe("temporalMedian — 血管の無い背景の近似", () => {
  it("🔴 ★ 一部のフレームにしか無い暗部は中央値で消える", () => {
    const w = 4;
    const h = 3;
    const bg = () => Float32Array.from({ length: w * h }, (_, i) => 1000 + i);
    const frames: Float32Array[] = [];
    for (let t = 0; t < 9; t++) {
      const f = bg();
      // 血管に相当する暗部を、フレームごとに**別の場所**へ置く（心拍で動く様子）。
      if (t < 4) f[t] = 200;
      frames.push(f);
    }
    const med = temporalMedian(frames, w, h);
    // 暗部を置いた画素も、背景の値に戻っていること。
    for (let i = 0; i < 4; i++) expect(med[i]).toBeCloseTo(1000 + i, 6);
  });

  it("★ 常に暗い場所は残る（それは背景である）", () => {
    const w = 3;
    const h = 2;
    const frames = Array.from({ length: 5 }, () => {
      const f = Float32Array.from({ length: w * h }, () => 1000);
      f[2] = 300;
      return f;
    });
    expect(temporalMedian(frames, w, h)[2]).toBe(300);
  });
});
