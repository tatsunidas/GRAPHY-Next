import { describe, expect, it } from "vitest";
import { estimateShift } from "./dsa";
import { ncc } from "./regMetrics";
import { warpRigid } from "./dsa";
import {
  alignOnEdges,
  amplitudeSpan,
  assignPhase,
  estimatePeriod,
  matchByAmplitude,
  motionSignal,
  prepareFrames,
  suggestTrackingRois,
  trackPrepared,
  trackTemplate,
  trajectorySpread,
  zncc,
  znccPrepared,
  type PixelRect,
  type TrackedFrame,
} from "./xaTracking";

/* ------------------------------------------------------------------ */
/* 合成データ                                                           */
/*                                                                      */
/* 🚨 背景は**向きの違う構造を重ねる**。`fw/angio-design.md` §6.4.1 の罠 1 —— GNBP-XA-2 の  */
/*    背景が斜めの帯 2 本だけだったため、帯に沿った体動が原理的に回収できなかった。         */
/*    ここでも縞だけの背景を作ると「推定器が正しくても真値に戻らない」ので、追尾の精度を     */
/*    測る土俵としては壊れている。縞だけの背景は**わざと落ちることを確かめる**ために使う。   */
/* ------------------------------------------------------------------ */

const FPS = 15;
const DT_MS = 1000 / FPS;

function times(n: number, dtMs = DT_MS): number[] {
  return Array.from({ length: n }, (_, i) => i * dtMs);
}

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

function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

type Background = "mixed" | "stripes";

/** 連続関数としての背景。サブピクセルの真値を補間なしで作れる。 */
function backgroundAt(u: number, v: number, kind: Background): number {
  const stripe = 40 * Math.sin(((0.6 * u + 0.8 * v) * 2 * Math.PI) / 11);
  if (kind === "stripes") return 500 + stripe;
  const spine = 130 * Math.exp(-(((u - 55) / 5) ** 2));
  const ribs = 55 * Math.sin((v * 2 * Math.PI) / 17);
  let blobs = 0;
  for (const [bx, by] of [[38, 44], [86, 62], [64, 96], [100, 30]]) {
    blobs += 110 * Math.exp(-(((u - bx) ** 2 + (v - by) ** 2) / (2 * 4 ** 2)));
  }
  return 500 + stripe + spine + ribs + blobs;
}

interface SceneOptions {
  width: number;
  height: number;
  background?: Background;
  noise?: number;
  seed?: number;
  /** 線形の輝度変化 `gain*I + offset`（造影による明るさの変化を模す）。 */
  gain?: number;
  offset?: number;
}

/** 背景を (ox, oy) だけ動かした 1 フレーム。 */
function renderScene(ox: number, oy: number, opts: SceneOptions): Float32Array {
  const { width: w, height: h } = opts;
  const kind = opts.background ?? "mixed";
  const rng = mulberry32(opts.seed ?? 1);
  const noise = opts.noise ?? 0;
  const gain = opts.gain ?? 1;
  const offset = opts.offset ?? 0;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = backgroundAt(x - ox, y - oy, kind);
      out[y * w + x] = gain * v + offset + (noise > 0 ? noise * gaussian(rng) : 0);
    }
  }
  return out;
}

const W = 128;
const H = 128;
const ROI: PixelRect = { x0: 34, y0: 34, x1: 93, y1: 93 };

/* ------------------------------------------------------------------ */

describe("zncc — regMetrics.ncc と同じ定義であること", () => {
  it("★ 定義が 2 本に割れていないことを固定する", () => {
    const rng = mulberry32(7);
    const n = 64;
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) { a[i] = gaussian(rng); b[i] = 0.4 * a[i] + gaussian(rng); }
    expect(zncc(a, b, n)).toBeCloseTo(ncc({ fixed: a, moving: b, count: n }), 12);
  });

  it("輝度の一次変換 a·I+b に不変（造影で明るさが変わっても効く理由）", () => {
    const a = Float64Array.from([1, 4, 2, 8, 5, 7]);
    const b = Float64Array.from(a, (v) => 3.5 * v - 40);
    expect(zncc(a, b, a.length)).toBeCloseTo(1, 12);
  });

  it("分散 0 や標本 1 個は 0（無情報。最悪の −1 を返さない）", () => {
    expect(zncc([1, 1, 1], [1, 2, 3], 3)).toBe(0);
    expect(zncc([1], [1], 1)).toBe(0);
  });
});

describe("trackTemplate — 固定テンプレートの逐次追尾", () => {
  /** 既知のずれを並べたランを作る。**整数と端数を両方入れる**。 */
  const OFFSETS: Array<[number, number]> = [
    [0, 0], [1, 0], [0, -2], [3, -2], [-4, 5], [1.4, -0.6], [-2.5, 0.5], [6, -6],
  ];

  it("★ 位置誤差が 0.2px 未満（整数の動きも端数の動きも）", () => {
    const frames = OFFSETS.map(([ox, oy], i) =>
      renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 100 + i }));
    const tr = trackTemplate(frames, W, H, ROI, { searchRadius: 10 });
    expect(tr.reliable).toBe(true);
    for (let i = 0; i < OFFSETS.length; i++) {
      expect(Math.abs(tr.frames[i].dx - OFFSETS[i][0])).toBeLessThan(0.2);
      expect(Math.abs(tr.frames[i].dy - OFFSETS[i][1])).toBeLessThan(0.2);
      expect(tr.frames[i].reliable).toBe(true);
    }
  });

  it("🚨 整数のずれが端数へ引き込まれない（σ=0.8 のぼかしが効いていること）", () => {
    // 探索前のぼかしが無いと、双線形／放物線の補間がノイズを平滑化するぶん
    // 「端数の位置のほうが相関が高い」方向へ 0.3px 級の偏りが出る（GNBP-XA-2 の実測）。
    const integers: Array<[number, number]> = [[2, 0], [0, 3], [-3, -3], [5, 2]];
    const frames = integers.map(([ox, oy], i) =>
      renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 200 + i }));
    const tr = trackTemplate(frames, W, H, ROI, { searchRadius: 10, referenceFrame: 0 });
    // 参照フレーム自身は (2,0) なので、その差分で評価する。
    for (let i = 0; i < integers.length; i++) {
      expect(tr.frames[i].dx).toBeCloseTo(integers[i][0] - integers[0][0], 1);
      expect(tr.frames[i].dy).toBeCloseTo(integers[i][1] - integers[0][1], 1);
    }
  });

  it("🚨 ROI の明るさが一次変換で変わっても追える（ZNCC が不変だから）", () => {
    const truth: Array<[number, number]> = [[0, 0], [2.5, -1.5], [-3, 4]];
    const frames = truth.map(([ox, oy], i) =>
      renderScene(ox, oy, {
        width: W, height: H, noise: 2, seed: 300 + i,
        gain: i === 0 ? 1 : 1.6, offset: i === 0 ? 0 : -260,
      }));
    const tr = trackTemplate(frames, W, H, ROI, { searchRadius: 10 });
    for (let i = 0; i < truth.length; i++) {
      expect(Math.abs(tr.frames[i].dx - truth[i][0])).toBeLessThan(0.2);
      expect(Math.abs(tr.frames[i].dy - truth[i][1])).toBeLessThan(0.2);
    }
  });

  it("🚨 dsa.estimateShift（背景 RMS 最小化）は輝度が変わると外れる — だから追尾には使わない", () => {
    // 🔴 **`estimateShift` が悪いという話ではない。** 輝度スケールが揃っているとき
    //    （＝DSA 本来の用途。マスクとライブは同一収集）はこちらのほうが正確である。
    //    壊れるのは「同じ被写体なのに明るさが違う」場合だけで、追尾はまさにそれに当たる。
    // 実測:
    //                      ZNCC 追尾     estimateShift
    //   輝度変化なし          0.066px       0.000px  ← RMS の勝ち
    //   gain1.6/offset-260    0.067px       0.583px  ← RMS が崩れる／ZNCC は不変
    const [ox, oy] = [2.5, -1.5];
    const ref = renderScene(0, 0, { width: W, height: H, noise: 2, seed: 400 });

    const plain = renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 401 });
    const plainRms = estimateShift(ref, plain, W, H, false, 10);
    expect(Math.hypot(plainRms.dx - ox, plainRms.dy - oy)).toBeLessThan(0.2);

    const scaled = renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 401, gain: 1.6, offset: -260 });
    const tr = trackTemplate([ref, scaled], W, H, ROI, { searchRadius: 10 });
    const trackErr = Math.hypot(tr.frames[1].dx - ox, tr.frames[1].dy - oy);
    const rms = estimateShift(ref, scaled, W, H, false, 10);
    const rmsErr = Math.hypot(rms.dx - ox, rms.dy - oy);

    expect(trackErr).toBeLessThan(0.2);
    expect(rmsErr).toBeGreaterThan(0.4);
    expect(rmsErr).toBeGreaterThan(5 * trackErr);
  });

  it("🚨 一方向の縞だけの背景では reliable:false（間違った数字を返さない）", () => {
    const offsets: Array<[number, number]> = [[0, 0], [2.4, -3.2], [-1.6, 2.1]];
    const frames = offsets.map(([ox, oy], i) =>
      renderScene(ox, oy, { width: W, height: H, background: "stripes", noise: 2, seed: 500 + i }));
    const tr = trackTemplate(frames, W, H, ROI, { searchRadius: 10 });
    expect(tr.reliable).toBe(false);
    expect(tr.reason).toBe("aperture");
  });

  it("★ 前処理を使い回しても数値が変わらない（prepareFrames → trackPrepared ＝ trackTemplate）", () => {
    // `suggestTrackingRois` は候補ごとに追尾するので、前処理を 1 回にまとめてある。
    // **まとめたことで結果が変われば、速くなった代わりに別物になっている。**
    const offsets: Array<[number, number]> = [[0, 0], [2.5, -1.5], [-3, 4], [1.4, -0.6]];
    const frames = offsets.map(([ox, oy], i) =>
      renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 600 + i }));
    const direct = trackTemplate(frames, W, H, ROI, { searchRadius: 10 });
    const viaPrepared = trackPrepared(prepareFrames(frames, W, H, {}), ROI, { searchRadius: 10 });
    expect(viaPrepared.frames).toEqual(direct.frames);
    expect(viaPrepared.tensor).toEqual(direct.tensor);
    expect(viaPrepared.reliable).toBe(direct.reliable);
  });

  it("空の入力でも壊れない", () => {
    const tr = trackTemplate([], W, H, ROI);
    expect(tr.frames).toEqual([]);
    expect(tr.reliable).toBe(false);
  });
});

describe("alignOnEdges — DSA の体動補正（エッジで合わせる）", () => {
  it("★ 平行移動を 0.2px 未満で取り戻す（既定は回転を探さない）", () => {
    for (const [ox, oy] of [[0, 0], [3, -2], [-1.4, 0.6]] as Array<[number, number]>) {
      const mask = renderScene(0, 0, { width: W, height: H, noise: 2, seed: 1100 });
      const live = renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 1101 });
      const r = alignOnEdges(mask, live, W, H, { searchRadius: 8 });
      expect(r.rotationDeg).toBe(0);
      expect(r.reliable).toBe(true);
      expect(Math.hypot(r.dx - ox, r.dy - oy)).toBeLessThan(0.2);
    }
  });

  it("🔴 明るさが一次変換で変わっても外れない（同位相マスクは別の心拍から来る）", () => {
    const [ox, oy] = [2.5, -1.5];
    const mask = renderScene(0, 0, { width: W, height: H, noise: 2, seed: 1200 });
    const live = renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 1201, gain: 1.6, offset: -260 });
    const r = alignOnEdges(mask, live, W, H, { searchRadius: 8 });
    expect(Math.hypot(r.dx - ox, r.dy - oy)).toBeLessThan(0.2);
  });

  it("★ 回転を明示したときだけ回転を推定する（真値 ±0.5 度以内）", () => {
    const truthDeg = 2;
    const base = renderScene(0, 0, { width: W, height: H, noise: 1, seed: 1300 });
    // ライブ側を +2 度回した像にする（マスクを +2 度回すと合う）。
    const live = warpRigid(base, W, H, 0, 0, truthDeg);

    const noRot = alignOnEdges(base, live, W, H, { searchRadius: 8 });
    expect(noRot.rotationDeg).toBe(0);

    const withRot = alignOnEdges(base, live, W, H, {
      searchRadius: 8,
      maxRotationDeg: 4,
      rotationStepDeg: 0.5,
    });
    expect(Math.abs(withRot.rotationDeg - truthDeg)).toBeLessThan(0.5);
    // 回転を入れたほうが相関が上がる（入れた意味があること）。
    expect(withRot.score).toBeGreaterThan(noRot.score);
  });

  it("回転が無い像に回転を探しても 0 付近で止まる（無い自由度を使い込まない）", () => {
    const mask = renderScene(0, 0, { width: W, height: H, noise: 1, seed: 1400 });
    const live = renderScene(2, -1, { width: W, height: H, noise: 1, seed: 1401 });
    const r = alignOnEdges(mask, live, W, H, { searchRadius: 8, maxRotationDeg: 3, rotationStepDeg: 0.5 });
    expect(Math.abs(r.rotationDeg)).toBeLessThan(0.6);
    expect(Math.hypot(r.dx - 2, r.dy + 1)).toBeLessThan(0.3);
  });

  it("🚨 一方向の縞しか無ければ reliable:false（合ったふりをしない）", () => {
    const mask = renderScene(0, 0, { width: W, height: H, background: "stripes", noise: 2, seed: 1500 });
    const live = renderScene(2.4, -3.2, { width: W, height: H, background: "stripes", noise: 2, seed: 1501 });
    const r = alignOnEdges(mask, live, W, H, { searchRadius: 8 });
    expect(r.reliable).toBe(false);
    expect(r.reason).toBe("aperture");
  });
});

describe("znccPrepared — 候補を「画像で」1 個に決めるための比較", () => {
  it("★ 正しいシフトで最大になり、ずらすと下がる（サブピクセル）", () => {
    const truth: [number, number] = [2.5, -1.5];
    const a = renderScene(0, 0, { width: W, height: H, noise: 1, seed: 900 });
    const b = renderScene(truth[0], truth[1], { width: W, height: H, noise: 1, seed: 901 });
    const prep = prepareFrames([a, b], W, H, {});
    const at = (dx: number, dy: number) => znccPrepared(prep, 0, prep, 1, ROI, dx, dy);
    const best = at(truth[0], truth[1]);
    expect(best).toBeGreaterThan(0.9);
    expect(at(0, 0)).toBeLessThan(best);
    expect(at(truth[0] + 1, truth[1])).toBeLessThan(best);
    expect(at(truth[0], truth[1] - 1)).toBeLessThan(best);
  });

  it("同じフレームどうし・シフト 0 は 1", () => {
    const a = renderScene(0, 0, { width: W, height: H, noise: 1, seed: 902 });
    const prep = prepareFrames([a], W, H, {});
    expect(znccPrepared(prep, 0, prep, 0, ROI, 0, 0)).toBeCloseTo(1, 9);
  });

  it("🔴 明るさが一次変換で変わっても値が変わらない（造影で背景が動いても効く）", () => {
    const a = renderScene(0, 0, { width: W, height: H, noise: 0 });
    const plain = renderScene(1.5, -2, { width: W, height: H, noise: 0 });
    const scaled = renderScene(1.5, -2, { width: W, height: H, noise: 0, gain: 1.7, offset: -300 });
    const p1 = prepareFrames([a, plain], W, H, {});
    const p2 = prepareFrames([a, scaled], W, H, {});
    expect(znccPrepared(p2, 0, p2, 1, ROI, 1.5, -2)).toBeCloseTo(
      znccPrepared(p1, 0, p1, 1, ROI, 1.5, -2),
      6,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 拍動する運動（非対称な波形）                                          */
/*                                                                      */
/* 🔴 心拍は正弦ではない。収縮は速く、拡張はゆっくりで、**RR が延びるときに延びるのは       */
/*    主に拡張期**である。位相（時間割合）で合わせると位置がずれるのはこのためで、          */
/*    正弦波で試すと phase sorting と amplitude sorting の差が出ない（＝テストにならない）。*/
/* ------------------------------------------------------------------ */

/** 1 心拍ぶんの位置。収縮期 `systoleSec` で +amp → −amp、残りで −amp → +amp。 */
function cardiacPosition(tSec: number, periodSec: number, systoleSec: number, amp: number): number {
  const u = ((tSec % periodSec) + periodSec) % periodSec;
  if (u < systoleSec) return amp * Math.cos(Math.PI * (u / systoleSec));
  return -amp * Math.cos(Math.PI * ((u - systoleSec) / (periodSec - systoleSec)));
}

const AXIS: [number, number] = [0.6, 0.8];

interface Run {
  frames: Float32Array[];
  pos: number[];
  vel: number[];
  times: number[];
}

function cardiacRun(n: number, periodSec: number, systoleSec: number, amp: number, seed: number): Run {
  const frames: Float32Array[] = [];
  const pos: number[] = [];
  const ts = times(n);
  for (let i = 0; i < n; i++) {
    const p = cardiacPosition(ts[i] / 1000, periodSec, systoleSec, amp);
    pos.push(p);
    frames.push(renderScene(p * AXIS[0], p * AXIS[1], { width: W, height: H, noise: 2, seed: seed + i }));
  }
  const vel = pos.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    return (pos[b] - pos[a]) / ((ts[b] - ts[a]) / 1000);
  });
  return { frames, pos, vel, times: ts };
}

/**
 * そのマスクフレームを選んだときの**位置のずれ [px]**（真値で測る）。
 *
 * 🔴 **フレーム番号で正解・不正解を判定してはいけない。** ランには心拍が何周期も入っていて、
 * 同じ位相のフレームが周期の数だけ存在する。DSA にとってはそのどれを引いても同じなので、
 * 「何番を選んだか」ではなく「**選んだ結果、解剖が何 px ずれているか**」が評価すべき量である。
 */
function positionError(mask: Run, live: Run, m: number, t: number): number {
  return Math.abs(mask.pos[m] - live.pos[t]);
}

/** 向きが合う候補の中で達成できる最小の位置ずれ（オラクル）。離散化の下限。 */
function oracleError(mask: Run, live: Run, t: number): number {
  const want = Math.sign(live.vel[t]);
  let best = Infinity;
  for (let m = 0; m < mask.pos.length; m++) {
    if (Math.sign(mask.vel[m]) !== want) continue;
    best = Math.min(best, Math.abs(mask.pos[m] - live.pos[t]));
  }
  return best;
}

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

describe("周期化と対応付け", () => {
  // マスク run: 周期 10 フレーム（HR 90）。ライブ run: 周期 12 フレーム（HR 75）＝ **20% 長い**。
  // 収縮期はどちらも 0.30 秒で固定し、**延びるのは拡張期だけ**にしてある。
  const MASK = cardiacRun(60, 10 / FPS, 0.3, 6, 1000);
  const LIVE = cardiacRun(60, 12 / FPS, 0.3, 6, 2000);

  const trackOf = (run: Run) => trackTemplate(run.frames, W, H, ROI, { searchRadius: 12 });
  const maskTrack = trackOf(MASK);
  const liveTrack = trackOf(LIVE);
  // 🔴 2 ラン間で振幅を比べるので、**ライブ側はマスク側と同じ軸**で射影する。
  const maskSig = motionSignal(maskTrack, MASK.times, { detrendWindowFrames: 0 });
  const liveSig = motionSignal(liveTrack, LIVE.times, { detrendWindowFrames: 0, axis: maskSig.axis });

  it("追尾そのものが成立している", () => {
    expect(maskTrack.reliable).toBe(true);
    expect(liveTrack.reliable).toBe(true);
  });

  it("★ 運動信号が真値の位置と一致する（PCA 主軸・px のまま）", () => {
    for (let i = 0; i < MASK.pos.length; i++) {
      expect(Math.abs(maskSig.s[i] - MASK.pos[i])).toBeLessThan(0.3);
    }
  });

  it("★ 周期推定が真値の ±1 フレーム以内", () => {
    const pm = estimatePeriod(maskSig.s, MASK.times);
    const pl = estimatePeriod(liveSig.s, LIVE.times);
    expect(pm.confidence).not.toBe("none");
    expect(pl.confidence).not.toBe("none");
    expect(Math.abs(pm.periodFrames - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(pl.periodFrames - 12)).toBeLessThanOrEqual(1);
  });

  it("★ 振幅＋向きの対応付けが「達成できる最善」からほとんど離れない", () => {
    const matches = matchByAmplitude(maskSig, liveSig, { k: 3 });
    const errs: number[] = [];
    for (const m of matches) {
      if (m.status === "outOfRange") continue;
      expect(m.candidates.length).toBeGreaterThan(0);
      const err = positionError(MASK, LIVE, m.candidates[0].maskFrame, m.liveFrame);
      // 離散化で決まる下限（オラクル）に 0.5px 以内で並ぶこと。
      expect(err).toBeLessThan(oracleError(MASK, LIVE, m.liveFrame) + 0.5);
      errs.push(err);
    }
    expect(errs.length).toBeGreaterThan(40);
    // 振幅 6px（振れ幅 12px）・1 周期 10 フレームなので、中央値 1px 以下なら十分。
    expect(median(errs)).toBeLessThan(1);
  });

  it("🔴 周期が 20% 違うと**位相**の対応付けは崩れる（振幅は崩れない）", () => {
    const pm = estimatePeriod(maskSig.s, MASK.times);
    const pl = estimatePeriod(liveSig.s, LIVE.times);
    const maskPhase = assignPhase(maskSig.s, MASK.times, pm.periodFrames);
    const livePhase = assignPhase(liveSig.s, LIVE.times, pl.periodFrames);
    expect(maskPhase.reliable).toBe(true);
    expect(livePhase.reliable).toBe(true);

    const matches = matchByAmplitude(maskSig, liveSig, { k: 1 });
    const ampErr: number[] = [];
    const phaseErr: number[] = [];
    for (const m of matches) {
      if (m.status === "outOfRange") continue;
      ampErr.push(positionError(MASK, LIVE, m.candidates[0].maskFrame, m.liveFrame));

      // 位相だけで選ぶ（RT 標準の phase sorting をそのまま当てた場合）。
      let bestM = 0;
      let best = Infinity;
      for (let i = 0; i < maskPhase.phase.length; i++) {
        const d = Math.abs(maskPhase.phase[i] - livePhase.phase[m.liveFrame]);
        const circular = Math.min(d, 1 - d);
        if (circular < best) { best = circular; bestM = i; }
      }
      phaseErr.push(positionError(MASK, LIVE, bestM, m.liveFrame));
    }
    // 実測（60 フレーム・振れ幅 12px・HR 90 vs 75）:
    //            中央値  平均  p90   最大  >=1px  >=2px
    //   振幅      0.227  0.358 0.93  1.03    5      0
    //   位相      0.434  0.765 2.64  2.71   14      9
    // 🔴 **差は中央値ではなく裾に出る。** 位相で合わせると、拡張期の長さが違うぶん
    //    「解剖が 2px 以上ずれたマスク」を 60 フレーム中 9 枚で掴む。振幅では 1 枚も無い。
    expect(median(phaseErr)).toBeGreaterThan(median(ampErr));
    expect(Math.max(...ampErr)).toBeLessThan(1.5);
    expect(ampErr.filter((e) => e >= 2).length).toBe(0);
    expect(phaseErr.filter((e) => e >= 2).length).toBeGreaterThanOrEqual(5);
  });

  it("🔴 振幅が同じで向きが逆のフレームを取り違えない", () => {
    const matches = matchByAmplitude(maskSig, liveSig, { k: 1 });
    const eps = 0.2 * Math.max(...Array.from(liveSig.sdot, Math.abs));
    let checked = 0;
    for (const m of matches) {
      if (m.status !== "ok" || !m.candidates.length) continue;
      const v = liveSig.sdot[m.liveFrame];
      if (Math.abs(v) < eps) continue; // 折り返し点は符号がノイズなので除く
      expect(Math.sign(maskSig.sdot[m.candidates[0].maskFrame])).toBe(Math.sign(v));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("estimatePeriod — オクターブ誤り（倍周期へのロック）", () => {
  /**
   * 🔴 **拍ごとに振れ幅が違う**心拍。呼吸で心臓の移動量が変わると実データでこうなる。
   * 自己相関は `r(2T) ≈ r(T)` になりやすく、振幅が交互だと**倍のほうがわずかに高く出る**。
   * 実機（Rubo Run1・137 フレーム・25fps）で **33.1 フレーム＝45 bpm** と出た形。
   */
  function alternating(n: number, periodFrames: number, ampA: number, ampB: number): number[] {
    return Array.from({ length: n }, (_, i) => {
      const beat = Math.floor(i / periodFrames);
      const amp = beat % 2 === 0 ? ampA : ampB;
      const u = (i % periodFrames) / periodFrames;
      // 非対称（収縮は速く、拡張はゆっくり）
      return u < 0.35 ? amp * Math.cos(Math.PI * (u / 0.35)) : -amp * Math.cos(Math.PI * ((u - 0.35) / 0.65));
    });
  }

  it("★ 振れ幅が拍ごとに違っても倍周期へロックしない", () => {
    const T = 10;
    const ts = times(120);
    const s = Float64Array.from(alternating(120, T, 6, 4.2));
    const p = estimatePeriod(s, ts);
    expect(p.confidence).not.toBe("none");
    // 🔴 補正が無いと 2T（=20）付近に張り付く。
    expect(Math.abs(p.periodFrames - T)).toBeLessThanOrEqual(1);
  });

  it("本当に周期が長いだけの波形を半分にしない（行き過ぎない）", () => {
    const T = 20;
    const ts = times(160);
    const s = Float64Array.from({ length: 160 }, (_, i) => 5 * Math.sin((2 * Math.PI * i) / T));
    const p = estimatePeriod(s, ts);
    expect(Math.abs(p.periodFrames - T)).toBeLessThanOrEqual(1);
  });

  it("生理的な下限（200bpm）より下へは降りない", () => {
    // 15fps・周期 6 フレーム（=400ms, 150bpm）。半分にすると 200bpm を超えるので降りない。
    const T = 6;
    const ts = times(90);
    const s = Float64Array.from({ length: 90 }, (_, i) => 5 * Math.sin((2 * Math.PI * i) / T));
    const p = estimatePeriod(s, ts);
    expect(p.periodFrames).toBeGreaterThanOrEqual(Math.ceil(300 / (1000 / FPS)));
  });
});

describe("estimatePeriod — 測れないときは測れないと言う", () => {
  it("🔴 1 周期が 4 フレーム未満なら位相を返さない（推定して当てにいかない）", () => {
    // 5fps で周期 0.6 秒 ＝ 1 周期 3 フレーム。
    const dt = 200;
    const n = 40;
    const ts = times(n, dt);
    const s = Float64Array.from(ts, (t) => Math.sin((2 * Math.PI * t) / 600));
    const p = estimatePeriod(s, ts);
    expect(p.confidence).toBe("none");
    expect(p.reason).toBe("tooFewSamplesPerCycle");
    expect(p.periodFrames).toBe(0);
    expect(assignPhase(s, ts, p.periodFrames).reliable).toBe(false);
  });

  it("周期らしい構造が無ければ none", () => {
    const rng = mulberry32(11);
    const n = 60;
    const ts = times(n);
    const s = Float64Array.from({ length: n }, () => gaussian(rng));
    expect(estimatePeriod(s, ts).confidence).toBe("none");
  });

  it("ランが 1 周期ぶんも無ければ none", () => {
    const ts = times(5);
    const s = Float64Array.from(ts, (t) => Math.sin((2 * Math.PI * t) / 660));
    expect(estimatePeriod(s, ts).confidence).toBe("none");
  });
});

describe("matchByAmplitude — 覆えていないところは正直に空で返す", () => {
  const mk = (amp: number, n: number): { s: Float64Array; sdot: Float64Array } => {
    const s = new Float64Array(n);
    const sdot = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = amp * Math.sin((2 * Math.PI * i) / 10);
      sdot[i] = amp * Math.cos((2 * Math.PI * i) / 10);
    }
    return { s, sdot };
  };

  it("🔴 マスクの振幅範囲がライブを覆っていないフレームは outOfRange（無理に当てない）", () => {
    const matches = matchByAmplitude(mk(3, 40), mk(8, 40), {});
    const out = matches.filter((m) => m.status === "outOfRange");
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) expect(m.candidates).toEqual([]);
    // 覆えている範囲は普通に返る。
    expect(matches.some((m) => m.status === "ok" && m.candidates.length > 0)).toBe(true);
  });

  it("向きが合う候補が無ければ制約を外し、そのことを status で言う", () => {
    const mask = { s: Float64Array.from([0, 1, 2, 3]), sdot: Float64Array.from([1, 1, 1, 1]) };
    const live = { s: Float64Array.from([2]), sdot: Float64Array.from([-1]) };
    const m = matchByAmplitude(mask, live, { k: 1, velocityEpsFraction: 0 });
    expect(m[0].status).toBe("directionRelaxed");
    expect(m[0].candidates[0].maskFrame).toBe(2);
  });

  it("同点は若いフレームを採る（決定性★）", () => {
    const mask = { s: Float64Array.from([5, 5, 5]), sdot: Float64Array.from([1, 1, 1]) };
    const live = { s: Float64Array.from([5]), sdot: Float64Array.from([1]) };
    expect(matchByAmplitude(mask, live, { k: 1 })[0].candidates[0].maskFrame).toBe(0);
  });
});

describe("suggestTrackingRois — 提案であって決定ではない", () => {
  it("🚨 縞だけの領域を候補の先頭に出さない（アパーチャ問題の ROI を薦めない）", () => {
    // 左半分は縞だけ、右半分は向きの違う構造を重ねた背景。動きは共通。
    const offsets: Array<[number, number]> = [[0, 0], [2, 1.5], [0, -2], [-2, -1.5], [0, 2], [2, 0]];
    const frames = offsets.map(([ox, oy], i) => {
      const mixed = renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 700 + i });
      const stripes = renderScene(ox, oy, { width: W, height: H, background: "stripes", noise: 2, seed: 800 + i });
      const out = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          out[y * W + x] = x < W / 2 ? stripes[y * W + x] : mixed[y * W + x];
        }
      }
      return out;
    });
    // 🚨 **探索半径はこの場面の動き（最大 2.5px）に合わせる。** 既定の ±20px は縞の周期
    //    11px の 2 周期ぶんを覆ってしまい、どのタイルも**隣の縞へ乗り移る**（真の動きが
    //    2.5px なのに 15〜19px の変位が返る）。それはアパーチャ問題ではなく周期模様の罠で、
    //    このテストが見たいものではない。半径を合わせると全タイルが 2.2〜2.35px と正しく
    //    追え、順位は等方性だけで決まる——それがここで確かめたいことである。
    const cands = suggestTrackingRois(frames, W, H, {
      tileSize: 40, stride: 20, shortlist: 6, maxCandidates: 3, track: { searchRadius: 6 },
    });
    expect(cands.length).toBeGreaterThan(0);
    // 先頭の候補は右半分（縞でない側）に寄っていること。
    expect(cands[0].rect.x0).toBeGreaterThanOrEqual(W / 2 - 20);
    expect(cands[0].anisotropy).toBeGreaterThan(0.05);
  });

  it("🚨 画像の縁のタイルを候補にしない（偽の「動き」で 1 位を取るため）", () => {
    // 窓が画像の外へ出ると端の値を複製するので、**ずらしても像が変わらず相関が落ちない**。
    // 実機（Rubo Run1）で上端のタイル (96,0)–(159,63) が「動き 9.9px」と出て、
    // 本来より良い中腹のタイル（λ2/λ1 0.61・動き 6.7px）を押しのけて 1 位になった。
    const offsets: Array<[number, number]> = [[0, 0], [2, 1.5], [0, -2], [-2, -1.5], [0, 2], [2, 0]];
    const frames = offsets.map(([ox, oy], i) =>
      renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 1600 + i }));
    const cands = suggestTrackingRois(frames, W, H, { tileSize: 40, stride: 20, shortlist: 8, maxCandidates: 8 });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.rect.x0).toBeGreaterThanOrEqual(20);
      expect(c.rect.y0).toBeGreaterThanOrEqual(20);
      expect(c.rect.x1).toBeLessThanOrEqual(W - 1 - 20);
      expect(c.rect.y1).toBeLessThanOrEqual(H - 1 - 20);
    }
  });

  it("🚨 コリメータの外（値ちょうど 0）のタイルを候補にしない", () => {
    const offsets: Array<[number, number]> = [[0, 0], [2, 1.5], [-2, -1.5], [0, 2]];
    const frames = offsets.map(([ox, oy], i) => {
      const f = renderScene(ox, oy, { width: W, height: H, noise: 2, seed: 900 + i });
      // 左の帯をコリメータ外（ちょうど 0）にする。
      for (let y = 0; y < H; y++) for (let x = 0; x < 40; x++) f[y * W + x] = 0;
      return f;
    });
    const cands = suggestTrackingRois(frames, W, H, { tileSize: 32, stride: 16, shortlist: 6, maxCandidates: 5 });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) expect(c.rect.x0).toBeGreaterThanOrEqual(40);
  });
});


/* ------------------------------------------------------------------ */
/* Phase 5 — 実機で出た不具合の固定（`fw/angio-design.md` §6.9）          */
/* ------------------------------------------------------------------ */

describe("trajectorySpread — 1 枚の追尾ミスで跳ねない（5-A）", () => {
  /** ほぼ静止した 33 枚の軌跡。**実機（Rubo Run1・タイル 256,352）の形**。 */
  const almostStill = (): TrackedFrame[] =>
    Array.from({ length: 33 }, (_, i) => ({
      dx: -0.14 + 0.005 * i,
      dy: 0.03 * Math.sin(i),
      score: 0.9,
      reliable: true,
    }));

  it("🔴 ★ 1 点だけ (−15.5, +7.7) に飛んでも広がりは 0.5px 未満（RMS なら 3px 級）", () => {
    const frames = almostStill();
    // 実測そのもの: 33 枚中 32 枚が ±0.14px なのに 1 枚だけ飛んでいた。
    frames[8] = { dx: -15.51, dy: 7.69, score: 0.91, reliable: true };

    // 参考: 同じ軌跡の RMS（旧実装）は 3px 級に跳ね上がる。実機ではここに本物の揺れも
    //       重なって 4.97px になり、動きの上限（tileSize/4）に張り付いて 1 位を取っていた。
    const mx = frames.reduce((a, f) => a + f.dx, 0) / frames.length;
    const my = frames.reduce((a, f) => a + f.dy, 0) / frames.length;
    const rms = Math.sqrt(
      frames.reduce((a, f) => a + (f.dx - mx) ** 2 + (f.dy - my) ** 2, 0) / frames.length,
    );
    expect(rms).toBeGreaterThan(2.5);

    expect(trajectorySpread(frames)).toBeLessThan(0.5);
  });

  it("本当に動いている軌跡は潰さない（20px の往復はそのまま出る）", () => {
    const moving: TrackedFrame[] = Array.from({ length: 34 }, (_, i) => ({
      dx: 0, dy: 10 * Math.sin((2 * Math.PI * i) / 17), score: 0.9, reliable: true,
    }));
    expect(trajectorySpread(moving)).toBeGreaterThan(5);
  });

  it("主方向へ射影すると、帯に沿った滑り（アパーチャ）は消える", () => {
    // 勾配の強い向きが x（＝縞が縦）なのに、動きは y にしか出ていない＝滑り。
    const sliding: TrackedFrame[] = Array.from({ length: 20 }, (_, i) => ({
      dx: 0, dy: 12 * Math.sin(i), score: 0.95, reliable: true,
    }));
    expect(trajectorySpread(sliding)).toBeGreaterThan(5);
    expect(trajectorySpread(sliding, 0.75, [1, 0])).toBeLessThan(0.01);
  });
});

describe("amplitudeSpan — 振幅がノイズなら足切りできる（5-C）", () => {
  it("🔴 ★ 実機で自動採用されていた ROI の広がりは 0.5px 級（並べ替えに使えない）", () => {
    // 実測の分布に近い形（[-0.21, +0.28] の範囲に散らばる）。
    const s = Float64Array.from({ length: 33 }, (_, i) => 0.035 + 0.24 * Math.sin(i * 1.7));
    expect(amplitudeSpan(s)).toBeLessThan(2);
  });

  it("本物の心拍（振幅 17px）は通る", () => {
    const s = Float64Array.from({ length: 33 }, (_, i) => -7 + 8.7 * Math.sin((2 * Math.PI * i) / 16.8));
    expect(amplitudeSpan(s)).toBeGreaterThan(2);
  });

  it("部分集合だけを見る（造影前フレームだけで測るため）", () => {
    const s = Float64Array.from([0, 0, 0, 0, 0, 0, 100, 200, 300, 400]);
    expect(amplitudeSpan(s, [0, 1, 2, 3, 4, 5])).toBe(0);
    expect(amplitudeSpan(s, [6, 7, 8, 9])).toBeGreaterThan(100);
  });
});

describe("matchByAmplitude — 範囲外のクランプ（5-E）", () => {
  const mask = { s: Float64Array.from([0, 1, 2, 3, 4]), sdot: Float64Array.from([1, 1, 1, 1, 1]) };
  const live = { s: Float64Array.from([2, 6]), sdot: Float64Array.from([1, 1]) };

  it("🔴 既定は false のまま（範囲外は今までどおり候補なしで返る）", () => {
    const m = matchByAmplitude(mask, live, { k: 1 });
    expect(m[1].status).toBe("outOfRange");
    expect(m[1].candidates).toEqual([]);
  });

  it("★ true なら端のフレームを当て、status で外挿だと言う", () => {
    const m = matchByAmplitude(mask, live, { k: 1, clampOutOfRange: true });
    expect(m[0].status).toBe("ok");
    expect(m[1].status).toBe("clamped");
    expect(m[1].candidates[0].maskFrame).toBe(4); // いちばん上の端
    // 🔑 cost は丸めずに測る（どれだけ外挿したかが数字に残る）。
    expect(m[1].candidates[0].cost).toBeCloseTo(2, 10);
  });

  it("範囲内のフレームの答えは clampOutOfRange で変わらない", () => {
    const a = matchByAmplitude(mask, live, { k: 3 })[0];
    const b = matchByAmplitude(mask, live, { k: 3, clampOutOfRange: true })[0];
    expect(b.candidates).toEqual(a.candidates);
    expect(b.status).toBe(a.status);
  });
});

describe("suggestTrackingRois — 動く低等方タイルを見落とさない（5-B）", () => {
  it("🔴 ★ 静止した等方タイルより、動いている（等方性の低い）タイルを上に出す", () => {
    // 左: 動かない格子（等方的で追いやすい）。右: 動く縁（一方向寄りだが本物の運動）。
    const w = 160;
    const h = 96;
    const frames: Float32Array[] = [];
    for (let t = 0; t < 24; t++) {
      const shift = 6 * Math.sin((2 * Math.PI * t) / 12); // 本物の心拍（振幅 12px）
      const f = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 500;
          if (x < w / 2) {
            // 静止した格子。動かないので位相信号は取れない。
            v += 90 * Math.sin((x * 2 * Math.PI) / 9) * Math.sin((y * 2 * Math.PI) / 9);
          } else {
            // 上下に動く縁 ＋ わずかな横構造（λ2 を 0 にしないため）。
            v += 120 / (1 + Math.exp(-(y - (48 + shift)) / 1.5));
            v += 18 * Math.sin((x * 2 * Math.PI) / 23);
          }
          f[y * w + x] = v;
        }
      }
      frames.push(f);
    }
    const cands = suggestTrackingRois(frames, w, h, {
      tileSize: 32, stride: 16, referenceFrame: 0, maxCandidates: 5, track: { searchRadius: 10 },
    });
    expect(cands.length).toBeGreaterThan(0);
    // 右半分（動いている側）が 1 位であること。
    expect(cands[0].rect.x0).toBeGreaterThanOrEqual(w / 2 - 16);
    expect(cands[0].motionPx).toBeGreaterThan(2);
  });
});
