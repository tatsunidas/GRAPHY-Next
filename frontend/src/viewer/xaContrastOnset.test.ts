import { describe, expect, it } from "vitest";
import {
  contrastStartFromFractions,
  roiSurveyWindow,
  darkenedFraction,
  detectContrastOnset,
  detectOnsetFromSignal,
  levelMatchedDifference,
  lowPercentileSignal,
  robustSpread,
} from "./xaContrastOnset";

/** 25fps（実機の Rubo Run1 と同じ）。 */
const DT = 40;
const times = (n: number, dt = DT): number[] => Array.from({ length: n }, (_, i) => i * dt);

/**
 * 🔑 **実機で測った曲線そのもの。**
 * Rubo `0009.DCM`（137 フレーム・25fps）の中央 50% ROI・10 パーセンタイル。
 *
 * - 0〜10 : 103 → 49  **露出の立ち上がり**（隣接差 −15〜−2）
 * - 11〜39: 49 → 60 → 55 前後  **造影前のプラトー**（心拍のさざ波 ±3）
 * - 40〜  : 53 → 35 前後  **造影による低下**
 *
 * 🔴 **合成データでこの不具合は再現しない。** 露出ランプが無いと基線が汚れず、
 * 既存の検出器でも通ってしまう。だから実測値を置いてある。
 */
const RUBO_RUN1_P10 = [
  103, 99, 84, 73, 69, 65, 60, 57, 53, 51, 49, 49, 50, 53, 56, 58, 59, 57, 59, 60,
  59, 58, 56, 56, 54, 55, 55, 55, 55, 56, 55, 55, 55, 55, 55, 56, 56, 56, 54, 53,
  51, 49, 48, 48, 46, 46, 46, 45, 44, 44, 43, 41, 41, 42, 41, 41, 39, 38, 36, 35,
  35, 36, 38, 40, 40, 40, 39, 39, 39, 39, 40, 39, 38, 37, 34, 33, 31, 31, 32, 35,
  38, 39, 38, 36, 37, 38, 38, 39, 38, 37, 35, 32, 30, 30, 30, 32, 34, 38, 38, 36,
  36, 36, 37, 38, 39, 38, 36, 34, 31, 30, 29, 30, 31, 34, 36, 36, 35, 35, 36, 37,
  37, 37, 37, 36, 33, 31, 30, 29, 30, 32, 34, 38, 38, 38, 38, 40, 34,
];

describe("detectOnsetFromSignal — 実機で測った曲線", () => {
  const r = detectOnsetFromSignal(RUBO_RUN1_P10, times(RUBO_RUN1_P10.length));

  it("★ 造影到達を 40〜55 フレームの範囲で見つける", () => {
    expect(RUBO_RUN1_P10).toHaveLength(137);
    expect(r.onset).not.toBeNull();
    expect(r.onset!).toBeGreaterThanOrEqual(40);
    expect(r.onset!).toBeLessThanOrEqual(55);
  });

  it("🔴 ★ 露出の立ち上がり（先頭約 10 フレーム）を基線から外す", () => {
    // ここを外さないのが既存検出器の失敗の正体。
    expect(r.stableFrom).toBeGreaterThanOrEqual(6);
    expect(r.stableFrom).toBeLessThanOrEqual(14);
    // 基線はプラトー（55 前後）を指しており、ランプの 103 に引きずられていない。
    expect(r.baselineMedian).toBeGreaterThan(50);
    expect(r.baselineMedian).toBeLessThan(62);
  });

  it("★ 造影前フレームが 1 心拍（約 17 フレーム）以上ある", () => {
    // 利用者の見立て「前半に 2 心拍程度の非造影」と整合すること。
    expect(r.preContrast.length).toBeGreaterThanOrEqual(17);
    expect(r.preContrast[0]).toBe(r.stableFrom);
    expect(r.preContrast[r.preContrast.length - 1]).toBe(r.onset! - 1);
  });

  it("基線の散らばりは心拍のさざ波ぶん（過大にならない）", () => {
    // 露出ランプが混ざると MAD が跳ねる。混ざっていないことを数値で固定する。
    expect(r.baselineMad).toBeLessThan(6);
    expect(r.threshold).toBeLessThan(r.baselineMedian);
    expect(r.threshold).toBeGreaterThan(30);
  });
});

describe("detectOnsetFromSignal — 落ちどころ", () => {
  it("🔴 ★ 造影が最初から入っているランでは onset を返さない（実測・Rubo 0002）", () => {
    /**
     * Rubo `0002.DCM`（96 フレーム・30fps）の同じ測り方の曲線。
     * **1 フレーム目から造影が入っている**ため（§6.6 の「正直な限界」）、
     * 低パーセンタイルは最初から造影の水準に張り付いて**一度も下がらない**。
     * → 造影前フレームが無いので**救えない**。それを黙って埋めないことが正しい。
     */
    const RUBO_0002_P10 = [
      37, 38, 36, 33, 30, 28, 28, 28, 29, 29, 30, 30, 30, 30, 31, 30, 30, 30, 30, 30,
      30, 30, 30, 30, 31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 31, 31, 31, 31, 31, 31,
      31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
      31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 30, 30, 31, 31, 31, 31, 31, 31,
      31, 31, 31, 31, 30, 30, 30, 30, 30, 30, 31, 30, 30, 30, 30, 30,
    ];
    expect(RUBO_0002_P10).toHaveLength(96);
    const r = detectOnsetFromSignal(RUBO_0002_P10, times(96, 1000 / 30));
    expect(r.onset).toBeNull();
    expect(r.reason).toBe("noSustainedDrop");
    expect(r.preContrast).toEqual([]);
  });

  it("造影が来ないラン（拍動だけ）では onset を返さない", () => {
    const s = Array.from({ length: 120 }, (_, i) => 55 + 3 * Math.sin((2 * Math.PI * i) / 17));
    const r = detectOnsetFromSignal(s, times(120));
    expect(r.onset).toBeNull();
    expect(r.reason).toBe("noSustainedDrop");
  });

  it("単発のスパイクでは発火しない（連続を要求する）", () => {
    const s = Array.from({ length: 120 }, (_, i) => 55 + 2 * Math.sin((2 * Math.PI * i) / 17));
    s[70] = 5;
    const r = detectOnsetFromSignal(s, times(120));
    expect(r.onset).toBeNull();
  });

  it("短すぎるランは tooShort", () => {
    expect(detectOnsetFromSignal([50, 50, 50], times(3)).reason).toBe("tooShort");
  });
});

describe("lowPercentileSignal — 画像から信号へ", () => {
  const W = 64, H = 64;
  /** 中央に一様な被写体、外周はコリメータ外（値ちょうど 0）。 */
  function frame(level: number, holeLevel?: number): Float32Array {
    const a = new Float32Array(W * H);
    for (let y = 8; y < H - 8; y++) {
      for (let x = 8; x < W - 8; x++) {
        // 🔴 暗部は ROI の 10% より大きくする。小さいと p10 が動かず、
        //    「造影が入っても信号が変わらない」検査になってしまう（面積 144/1024 = 14%）。
        a[y * W + x] = holeLevel != null && x >= 26 && x < 38 && y >= 26 && y < 38 ? holeLevel : level;
      }
    }
    return a;
  }

  it("🚨 コリメータ外（値 0）に支配されない", () => {
    const s = lowPercentileSignal([frame(100)], W, H, { centerFraction: 0.5, stride: 1 });
    expect(s[0]).toBe(100);
  });

  it("暗い構造（造影）が入ると低パーセンタイルが下がる", () => {
    const before = lowPercentileSignal([frame(100)], W, H, { centerFraction: 0.5, stride: 1 })[0];
    const after = lowPercentileSignal([frame(100, 20)], W, H, { centerFraction: 0.5, stride: 1 })[0];
    expect(after).toBeLessThan(before);
  });

  it("detectContrastOnset は画像から一息で答える", () => {
    const frames = [
      ...Array.from({ length: 30 }, () => frame(100)),
      ...Array.from({ length: 30 }, () => frame(100, 20)),
    ];
    const r = detectContrastOnset(frames, W, H, times(60), { centerFraction: 0.5, stride: 1, baselineMs: 400 });
    expect(r.onset).not.toBeNull();
    expect(Math.abs(r.onset! - 30)).toBeLessThanOrEqual(4);
  });
});


/* ------------------------------------------------------------------ */
/* Phase 6 — 造影が「本当に」始まるフレーム（`fw/angio-design.md` §6.10） */
/* ------------------------------------------------------------------ */

/**
 * 🔑 **実機で測った割合そのもの。** Rubo `0009.DCM` の造影前平均との差（レベル合わせ後）で、
 * 自己較正した床の 4σ（= 0.151）を超えて暗くなった画素の割合。index は 0-origin フレーム。
 *
 * - 24〜31 : 0.48〜0.84%  造影前（基準値 0.37%）
 * - **32 から 1.16% へ跳ね、以後 onset まで戻らない** ← ここが本当の造影開始
 * - 既存の `detectOnsetFromSignal` が出す onset は **41**（9 フレーム遅い）
 */
const RUBO_RUN1_DARKENED: Record<number, number> = {
  8: 0.0037, 9: 0.0036, 10: 0.0035, 11: 0.0036, 12: 0.0037, 13: 0.0038,
  14: 0.0036, 15: 0.0037, 16: 0.0038, 17: 0.0039, 18: 0.0038, 19: 0.0037,
  20: 0.0038, 21: 0.0040, 22: 0.0042, 23: 0.0045, 24: 0.0048, 25: 0.0048,
  26: 0.0049, 27: 0.0053, 28: 0.0059, 29: 0.0069, 30: 0.0075, 31: 0.0084,
  32: 0.0116, 33: 0.0144, 34: 0.0135, 35: 0.0115, 36: 0.0113, 37: 0.0128,
  38: 0.0160, 39: 0.0204, 40: 0.0277,
};

describe("contrastStartFromFractions — 実機で測った割合", () => {
  const fractions: number[] = [];
  for (const [k, v] of Object.entries(RUBO_RUN1_DARKENED)) fractions[Number(k)] = v;

  it("🔴 ★ 造影開始を 32〜33 に当てる（p10 の onset 41 より 8〜9 フレーム手前）", () => {
    const start = contrastStartFromFractions(fractions, 8, 40);
    expect(start).toBeGreaterThanOrEqual(31);
    expect(start).toBeLessThanOrEqual(33);
  });

  it("🚨 ここを直さないと、造影の立ち上がり 9 フレームが自己差分で隠れる", () => {
    // 既存の検出器が出す onset。これを境界に使うと 32〜40 が「造影前」に入ってしまう。
    const roughOnset = 41;
    const start = contrastStartFromFractions(fractions, 8, 40);
    expect(roughOnset - start).toBeGreaterThanOrEqual(8);
  });

  it("造影前フレームだけを見ると、境界は動かない（誤検出しない）", () => {
    // 24 までで打ち切れば、その範囲に造影は無いので to がそのまま返る。
    expect(contrastStartFromFractions(fractions, 8, 24)).toBe(24);
  });

  it("単発の跳ねでは手前に行かない（「戻らない」ことを要求しているので）", () => {
    const f = [...fractions];
    f[20] = 0.05; // 1 フレームだけ大きく跳ねる
    expect(contrastStartFromFractions(f, 8, 40)).toBeGreaterThan(20);
  });

  it("🚨 一様に高いだけ（立ち上がりが無い）なら境界を作らない", () => {
    // 最初から造影が入っているランはここへ来ない——`detectOnsetFromSignal` が
    // 先に `onset = null` で降りる（実測・Rubo 0002）。ここは相対的な**跳ね**を見る器なので、
    // 一様に高い列からは何も読み取らず `to` を返すのが正しい。
    const f: number[] = [];
    for (let i = 8; i <= 40; i++) f[i] = 0.05;
    expect(contrastStartFromFractions(f, 8, 40)).toBe(40);
  });

  it("範囲が潰れていても落ちない", () => {
    expect(contrastStartFromFractions(fractions, 20, 20)).toBe(20);
    expect(contrastStartFromFractions(fractions, 30, 20)).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* §6.15 — 調査窓と「造影が混ざっていない接頭辞」は一致しない            */
/*                                                                      */
/* 🚨 この食い違いは**合成データでは再現しない**（contrastStart == onset  */
/*    にしてしまえば長さは一致する）。実機の「絞り込んだ造影開始は粗い    */
/*    onset より 9 フレーム早い」という関係が原因なので、実測でしか守れない。*/
/* ------------------------------------------------------------------ */

describe("roiSurveyWindow — 窓と接頭辞（§6.15）", () => {
  const onsetResult = detectOnsetFromSignal(RUBO_RUN1_P10, times(RUBO_RUN1_P10.length));
  const fractions: number[] = [];
  for (const [k, v] of Object.entries(RUBO_RUN1_DARKENED)) fractions[Number(k)] = v;
  const roughPre = onsetResult.preContrast;
  // ⚠️ 実測の割合フィクスチャ `RUBO_RUN1_DARKENED` はフレーム 8〜40 しか持っていないので、
  //    絞り込みの範囲もそこで打ち切る（本番は窓の全フレームぶん計算する）。
  const contrastStart = contrastStartFromFractions(fractions, roughPre[0], 40);
  const { window, surveyFrames } = roiSurveyWindow(roughPre, contrastStart, 48);

  it("🔴 ★ 造影開始の絞り込みが効くと、窓と接頭辞は必ず食い違う", () => {
    // **これが「時刻配列は窓の長さではない」ことの実測による錠。**
    // 以前はここが一致している前提で時刻を `window.length` 枚作っており、
    // 受け側（suggestTrackingRois）が長さ不一致で黙って時刻を捨てていた。
    expect(contrastStart).toBeLessThan(onsetResult.onset!);
    expect(surveyFrames.length).toBeLessThan(window.length);
    // 実機では 8〜9 フレームの差。
    expect(window.length - surveyFrames.length).toBeGreaterThanOrEqual(7);
  });

  it("🔴 ★ 接頭辞である（画素を窓の順に詰めて先頭から切り出せる）", () => {
    // 呼び出し側は `survey.subarray(0, surveyCount * frameSize)` で切り出すので、
    // ここが接頭辞でないと**画素と時刻が別のフレームを指す**。
    expect(surveyFrames.every((t, i) => t === window[i])).toBe(true);
  });

  it("★ 境界の両側が正しく分かれている", () => {
    expect(surveyFrames.every((t) => t < contrastStart)).toBe(true);
    expect(window.slice(surveyFrames.length).every((t) => t >= contrastStart)).toBe(true);
  });

  it("★ 実機の枚数の範囲に収まる", () => {
    expect(window.length).toBeGreaterThanOrEqual(30);
    expect(window.length).toBeLessThanOrEqual(40);
    expect(surveyFrames.length).toBeGreaterThanOrEqual(20);
    expect(surveyFrames.length).toBeLessThanOrEqual(28);
  });

  it("上限を超えるランでは onset 側に寄せた連続した窓を取る", () => {
    const long = Array.from({ length: 100 }, (_, i) => i);
    const r = roiSurveyWindow(long, 95, 48);
    expect(r.window).toHaveLength(48);
    expect(r.window[0]).toBe(52);
    expect(r.window[47]).toBe(99);
    expect(r.surveyFrames).toHaveLength(43); // 52..94
  });

  it("造影開始が窓より後ろなら、全部が接頭辞になる（退化ケース）", () => {
    const r = roiSurveyWindow([3, 4, 5, 6], Number.POSITIVE_INFINITY, 48);
    expect(r.surveyFrames).toEqual(r.window);
  });
});

describe("levelMatchedDifference / robustSpread / darkenedFraction", () => {
  const W = 40, H = 40;
  const scene = (gain: number, dark?: { x0: number; x1: number }): Float32Array => {
    const f = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 60 + 20 * Math.sin((x * 2 * Math.PI) / 13);
        if (dark && x >= dark.x0 && x <= dark.x1) v -= 30;   // 造影に見立てた暗い帯
        f[y * W + x] = gain * v;
      }
    }
    return f;
  };

  it("🔴 一様なゲインの差は中央値で消える（露出が変わっても誤検出しない）", () => {
    const d = levelMatchedDifference(scene(1.9), scene(1), true, 1);
    expect(Math.abs(robustSpread(d))).toBeLessThan(0.02);
    expect(darkenedFraction(d, 0.15)).toBeLessThan(0.01);
  });

  it("★ 画面の一部だけが暗くなると割合として出る", () => {
    const d = levelMatchedDifference(scene(1), scene(1, { x0: 18, x1: 21 }), true, 1);
    // 4/40 列 ＝ 10%。中央値を引いているぶん少し目減りする。
    expect(darkenedFraction(d, 0.15)).toBeGreaterThan(0.05);
  });

  it("🚨 どちらかがちょうど 0 の画素は外す（コリメータの外）", () => {
    const a = scene(1);
    const b = scene(1);
    for (let i = 0; i < a.length / 2; i++) { a[i] = 0; b[i] = 0; }
    const d = levelMatchedDifference(a, b, true, 1);
    expect(d.length).toBeLessThan(a.length * 0.6);
    expect(darkenedFraction(d, 0.15)).toBe(0);
  });

  it("robustSpread は素材のノイズを拾う（床を定数で決め打たないため）", () => {
    const a = scene(1);
    const b = Float32Array.from(a, (v, i) => v + ((i * 2654435761) % 7) - 3); // 全画素に散らばり
    const sp = robustSpread(levelMatchedDifference(a, b, true, 1));
    expect(sp).toBeGreaterThan(0.01);
    expect(sp).toBeLessThan(0.5);
  });

  it("🚨 半分未満の画素しか違わないと MAD は 0 になる（そのときは境界を作らない）", () => {
    // MAD の性質。実データは全画素にノイズが乗るので起きないが、起きたときに
    // 0 を床として使うと閾値も 0 になり全画素が「造影」になる。
    // `xaAutoPhaseMask` は spread が 0 なら粗い onset のまま降りる。
    const a = scene(1);
    const b = Float32Array.from(a, (v, i) => v + (i % 7 === 0 ? 3 : 0));
    expect(robustSpread(levelMatchedDifference(a, b, true, 1))).toBe(0);
  });
});
