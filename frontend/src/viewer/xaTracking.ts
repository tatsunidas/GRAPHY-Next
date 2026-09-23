/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA シネの**自動追尾と、造影前／造影後のフレーム対応付け**（`fw/angio-design.md` §6.7）。
 * **純ロジックだけ**——DOM も Cornerstone も import しない（`dsa.ts` と同じ理由：数値の
 * 正しさを UI 抜きで vitest で守るため）。
 *
 * <h3>何のためにあるか</h3>
 * 心臓 XA の DSA は、心位相の違うマスクを引くと血管の二重像が残る（§6.6.2）。
 * ここは「造影前フレーム列を追尾して心臓の運動信号に変え、造影後の各フレームに
 * **解剖がいちばん近い位置にある**造影前フレームを当てる」ための計算を持つ。
 *
 * <h3>🔴 対応付けは「位相」ではなく「振幅＋向き」で行う（amplitude sorting）</h3>
 * 放射線治療の 4D 仕分けには phase sorting（ピーク間を時間で線形補間）と amplitude sorting
 * （信号の振幅そのもので仕分ける）の 2 系統があり、**本件は後者**である。理由は 2 つ：
 * <ul>
 *   <li>DSA が欲しいのは「心周期の同じ時間割合」ではなく「<b>解剖が同じ位置にあるフレーム</b>」</li>
 *   <li>造影剤注入で心拍数は動く。RR が延びても収縮期は比例して延びない（延びるのは拡張期）
 *       ので、<b>時間割合で合わせると位置がずれる</b>。振幅なら追尾 ROI が同じ限り px 単位で
 *       直接比べられるので、心拍数が違っても破綻しない</li>
 * </ul>
 * 位相（{@link assignPhase}）は**交差確認のためだけ**に残してある。
 *
 * <h3>🔴 `dsa.ts` の `estimateShift()` を追尾に使わないこと</h3>
 * あちらは差分の背景 RMS を最小化する。マスクとライブが**同一収集**の体動補正では正しいが、
 * 追尾では ROI の中のコントラストが造影で変わるため最小点がずれる。ZNCC は輝度の一次変換
 * `aI+b` に不変なので、そこに強い。
 */

import { blurSeparable, warpRigid } from "./dsa";
import {
  clampRect,
  sobelGradients,
  structureTensorFromGradients,
  type PixelRect,
  type StructureTensor,
} from "./edgeFilters";

export type { PixelRect } from "./edgeFilters";

/** 対数を取るときのゼロ除け（`dsa.ts` の `LOG_EPS` と同じ値にしてある）。 */
const LOG_EPS = 1e-3;

/**
 * 探索の前に掛けるガウシアンの σ [px]。
 *
 * <p>🚨 `dsa.ts` の `SEARCH_BLUR_SIGMA` と**同じ理由・同じ値**。これが無いと双線形／放物線の
 * 補間が「端数の位置のほうが残差が小さい」方向へ引き込み、整数の動きが 0.36px ずれて推定される
 * （GNBP-XA-2 で実測）。
 */
const SEARCH_BLUR_SIGMA = 0.8;

/** 生理的な心拍の範囲（HR 40〜200 bpm）。周期推定の探索範囲はここから決める。 */
const MIN_PERIOD_MS = 300;
const MAX_PERIOD_MS = 1500;

/**
 * 🔴 1 周期あたり最低これだけのフレームが無ければ**数字を出さない**。
 *
 * <p>放射線治療の透視は 30Hz で 0.3Hz の呼吸を追う＝1 周期 100 サンプル。XA は 15fps で
 * HR 90 なら 1 周期 10 サンプルしかない。ここを下回ると位相も対応付けも意味を持たないので、
 * 推定して当てにいくのではなく「測れない」と言う。
 */
const MIN_FRAMES_PER_CYCLE = 4;

/**
 * オクターブ補正の許容比（{@link estimatePeriod}）。
 *
 * <p>半分の遅れの相関が最良の相関のこの割合を超えていれば、**半分を採る**。
 * 1.0 に近いほど「倍にロックしたまま」になりやすく、小さいほど半分へ飛びやすい。
 */
/**
 * オクターブ補正の許容比。`r(T/2) > OCTAVE_TOLERANCE × r(T)` なら半分を採る。
 *
 * <p>🔑 **画面に出すために export している**——「補正が効いたのか、ぎりぎり落ちたのか」は
 * この敷居と `halfLagCorrelation` を並べて初めて読める（§6.15）。
 */
export const OCTAVE_TOLERANCE = 0.85;

/* ------------------------------------------------------------------ */
/* ZNCC                                                                */
/* ------------------------------------------------------------------ */

/**
 * 正規化相互相関（ZNCC）。範囲は [−1, 1]、**大きいほど良い**。
 *
 * <p>🔴 `regMetrics.ts` の {@code ncc()} と**同じ定義**だが、あちらは `SamplePair`
 * （`Float64Array` の対）を受ける。テンプレート照合は候補位置ごとにこれを呼ぶので、
 * 位置ごとに配列を確保すると `dsa.ts:shiftResidual()` がまさに避けた
 * 「UI が数十秒固まる」を踏む。**定義が 2 本に割れていないことは `xaTracking.test.ts` で
 * `regMetrics.ncc()` と突き合わせて固定してある。**
 *
 * <p>有効サンプルが 2 未満、またはどちらかの分散が 0 のときは 0 を返す（`regMetrics` と同じ。
 * 「相関が無い」＝無情報であって最悪ではない）。
 */
export function zncc(
  a: Float32Array | Float64Array | readonly number[],
  b: Float32Array | Float64Array | readonly number[],
  count: number,
): number {
  if (count < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < count; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / count;
  const mb = sb / count;
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < count; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    num += da * db;
    va += da * da;
    vb += db * db;
  }
  const den = Math.sqrt(va * vb);
  return den > 1e-12 ? num / den : 0;
}

/* ------------------------------------------------------------------ */
/* テンプレート追尾                                                     */
/* ------------------------------------------------------------------ */

/** 追尾の設定。 */
export interface TrackOptions {
  /** テンプレートを取るフレーム（既定 0）。 */
  referenceFrame?: number;
  /** 探索半径 [px]（既定 32）。心臓の面内運動を覆う大きさにする。 */
  searchRadius?: number;
  /** ピラミッドの段数（既定 3）。1 で単一解像度。 */
  pyramidLevels?: number;
  /** `PixelIntensityRelationship = LIN` の装置では true（対数域へ移してから追う）。 */
  logarithmic?: boolean;
  /**
   * **Sobel の勾配成分 (gx, gy) の 2 チャンネル**で追う（既定 true）。false は平滑化した生画素。
   *
   * <p>🚨 **勾配「強度」`|∇I|` を使ってはいけない**（実測で決めた）。絶対値は非線形で、
   * 零交差で折り返すぶん帯域が広がり、3×3 の曲面当てはめが当たらなくなる。同じ土俵で測った
   * サブピクセル誤差は **生画素 0.03px / 勾配成分 2ch 0.07px / 勾配強度 0.26px**。
   * 勾配成分は生画素と違って**高域通過**なので、造影で背景の明るさがゆっくり変わっても
   * 影響を受けにくい。だから既定は 2ch のほうにしてある。
   */
  useGradient?: boolean;
  /** 相関がこれ未満のフレームは `reliable:false`（既定 0.5）。 */
  minScore?: number;
  /** `lambda2/lambda1` がこれ未満なら ROI 全体をアパーチャ問題として落とす（既定 0.04）。 */
  minAnisotropy?: number;
  /**
   * 時間方向の外れフレームを落とす強さ（既定 6）。0 で無効。
   *
   * <p>🚨 **1 枚だけ飛ぶ追尾ミスは `reliable` のまま出てくる。** 実機（Rubo Run1・タイル
   * 256,352/64・造影前 33 枚）で、32 枚が ±0.14px に収まっているのに 1 枚だけ
   * **(−15.51, +7.69)** へ飛び、ZNCC も閾値を超えていて `reliable:true` だった。
   * これを残すと {@link RoiCandidate#motionPx} が 4.97px に跳ね上がり、**静止した ROI が
   * 「よく動く ROI」として 1 位を取る**（実機で踏んだ）。運動信号そのものも汚れる。
   */
  outlierFactor?: number;
  /** 外れ判定の下限 [px]（既定 0.5）。散らばりが 0 に近いときに全部を外れにしないため。 */
  minOutlierDistancePx?: number;
}

/** 1 フレームの追尾結果。 */
export interface TrackedFrame {
  /** 参照フレームからの変位 [px]（正で右／下）。 */
  dx: number;
  dy: number;
  /** そのフレームでの ZNCC の最大値。 */
  score: number;
  /** この 1 フレームの値を信用してよいか。 */
  reliable: boolean;
  /** `reliable:false` の理由。 */
  reason?: "lowScore" | "flatPeak" | "atSearchEdge" | "outlier";
}

/** 追尾の結果。 */
export interface TrackResult {
  frames: TrackedFrame[];
  referenceFrame: number;
  /** 参照フレームの ROI で測った構造テンソル。 */
  tensor: StructureTensor;
  /** ROI そのものが追尾に向いているか（アパーチャ問題・無地でないか）。 */
  reliable: boolean;
  reason?: "aperture" | "noTexture" | "tooFewReliableFrames";
}

/**
 * 画像の 1 段（ピラミッド用）。**多チャンネル**（`planes` 枚が連続して並ぶ）。
 * チャンネル `p` の画素 `(x,y)` は `data[p*width*height + y*width + x]`。
 */
interface Level {
  data: Float32Array;
  width: number;
  height: number;
  planes: number;
}

/** 生画素 → 対数（必要なら）→ σ=0.8 のガウシアン。**勾配はまだ取らない**。 */
function smoothFrame(src: Float32Array, width: number, height: number, logarithmic: boolean): Float32Array {
  let v = src;
  if (logarithmic) {
    v = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) v[i] = Math.log(Math.max(src[i], 0) + LOG_EPS);
  }
  return blurSeparable(v, width, height, SEARCH_BLUR_SIGMA);
}

/** 2 倍ダウンサンプル（先に σ=1 でぼかしてから間引く＝折り返しを作らない）。 */
function downsample(level: Level): Level {
  const { width: w, height: h, planes } = level;
  const w2 = Math.max(1, w >> 1);
  const h2 = Math.max(1, h >> 1);
  const out = new Float32Array(w2 * h2 * planes);
  for (let p = 0; p < planes; p++) {
    const pre = blurSeparable(level.data.subarray(p * w * h, (p + 1) * w * h), w, h, 1);
    const base = p * w2 * h2;
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) out[base + y * w2 + x] = pre[y * 2 * w + x * 2];
    }
  }
  return { data: out, width: w2, height: h2, planes };
}

function buildPyramid(base: Level, levels: number): Level[] {
  const out: Level[] = [base];
  for (let i = 1; i < levels; i++) {
    const prev = out[out.length - 1];
    if (prev.width < 16 || prev.height < 16) break;
    out.push(downsample(prev));
  }
  return out;
}

function clampIndex(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v;
}

/** テンプレート（切り出し済み・多チャンネル）と、正規化に要る統計。 */
interface Template {
  data: Float32Array;
  width: number;
  height: number;
  planes: number;
  /** ROI の左上（その段の座標系）。 */
  x0: number;
  y0: number;
  mean: number;
  /** Σ(T − T̄)²（全チャンネルまとめて）。 */
  variance: number;
}

function extractTemplate(level: Level, rect: PixelRect): Template {
  const r = clampRect(rect, level.width, level.height);
  const tw = r.x1 - r.x0 + 1;
  const th = r.y1 - r.y0 + 1;
  const data = new Float32Array(tw * th * level.planes);
  let sum = 0;
  let k = 0;
  for (let p = 0; p < level.planes; p++) {
    const base = p * level.width * level.height;
    for (let j = 0; j < th; j++) {
      const row = base + (r.y0 + j) * level.width;
      for (let i = 0; i < tw; i++) {
        const v = level.data[row + r.x0 + i];
        data[k++] = v;
        sum += v;
      }
    }
  }
  const mean = sum / Math.max(1, data.length);
  let variance = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean;
    variance += d * d;
  }
  return { data, width: tw, height: th, planes: level.planes, x0: r.x0, y0: r.y0, mean, variance };
}

/**
 * テンプレートを (ox, oy) だけずらした位置での ZNCC。**配列を確保しない**。
 * 画像の外は端の値で複製する（黒縁で相関を稼がないため）。
 *
 * <p>多チャンネルのときは**全チャンネルをまとめて 1 本のベクトルとして**正規化する
 * （チャンネルごとに正規化すると、勾配がほぼ 0 の向きのノイズを等しく重み付けしてしまう）。
 */
function znccAt(t: Template, level: Level, ox: number, oy: number): number {
  const n = t.width * t.height * t.planes;
  if (n < 2 || t.variance <= 1e-12) return 0;
  let sM = 0, sMM = 0, sTM = 0;
  let k = 0;
  for (let p = 0; p < t.planes; p++) {
    const plane = p * level.width * level.height;
    for (let j = 0; j < t.height; j++) {
      const sy = plane + clampIndex(t.y0 + oy + j, level.height - 1) * level.width;
      for (let i = 0; i < t.width; i++) {
        const m = level.data[sy + clampIndex(t.x0 + ox + i, level.width - 1)];
        sM += m;
        sMM += m * m;
        sTM += t.data[k++] * m;
      }
    }
  }
  const meanM = sM / n;
  const cov = sTM - n * t.mean * meanM;
  const varM = sMM - n * meanM * meanM;
  const den = Math.sqrt(t.variance * varM);
  return den > 1e-12 ? cov / den : 0;
}

/** 3 点の放物線当てはめ（1 次元）。返すのは中央からのずれ（|δ| ≤ 0.5 でなければ null）。 */
function parabolaPeak(left: number, center: number, right: number): number | null {
  const den = left - 2 * center + right;
  if (!(Math.abs(den) > 1e-9)) return null; // 平坦＝位置が決まっていない
  const d = (0.5 * (left - right)) / den;
  return Math.abs(d) <= 0.5 ? d : null;
}

/** サブピクセルの上限。これを超えるなら整数の最良点の選び方自体が怪しいので採らない。 */
const MAX_SUBPIXEL = 0.75;

/**
 * 3×3 の相関値に**2 次曲面**を当て、その頂点を返す（§3.3）。
 *
 * <p>🚨 **軸ごとに 1 次元の放物線を当ててはいけない。** 相関の峰は一般に軸に平行ではなく、
 * 斜めの構造があると `u` と `v` が結合する（構造テンソルの非対角成分がそのまま峰の傾きになる）。
 * 軸ごとに当てると、峰を通らない断面で頂点を探すことになり、**片方のずれがもう片方へ漏れる**。
 * 実測では、x にだけ 2.5px 動かした像で **y に −0.22px の嘘の変位**が出て、x も −2.5 → −1.95 まで
 * 崩れた。9 点で曲面を当てると両方とも真値へ戻る。
 *
 * <p>ヘッセ行列が負定値でなければ null を返す。これは「峰ではなく**尾根**」＝その向きの位置が
 * 決まっていない状態で、{@link ./edgeFilters#structureTensorEigen} のアパーチャ判定と
 * 同じことを**相関面の側から**見ている（ROI の中身ではなく、実際の合わせ具合で判定できる）。
 *
 * @param g `g[dv + 1][du + 1]`（中央が `g[1][1]`）
 */
function quadraticPeak2d(g: readonly (readonly number[])[]): { du: number; dv: number } | null {
  const c = g[1][1];
  const bx = (g[1][2] - g[1][0]) / 2;
  const by = (g[2][1] - g[0][1]) / 2;
  const hxx = g[1][2] - 2 * c + g[1][0];
  const hyy = g[2][1] - 2 * c + g[0][1];
  const hxy = (g[2][2] - g[2][0] - g[0][2] + g[0][0]) / 4;
  const det = hxx * hyy - hxy * hxy;
  if (!(hxx < 0 && hyy < 0 && det > 1e-12)) return null;
  const du = -(hyy * bx - hxy * by) / det;
  const dv = -(-hxy * bx + hxx * by) / det;
  if (!Number.isFinite(du) || !Number.isFinite(dv)) return null;
  if (Math.abs(du) > MAX_SUBPIXEL || Math.abs(dv) > MAX_SUBPIXEL) return null;
  return { du, dv };
}

/**
 * 固定テンプレートによる逐次追尾（§3.1〜3.4）。
 *
 * <p>**テンプレートは参照フレームのまま更新しない。** 毎フレーム更新すると誤差が累積して
 * 数十フレームで別物を追い始める（drift）。心拍は周期運動で必ず元の位置へ戻るので、
 * 固定テンプレート＋十分な探索半径で足りる。探索の中心も毎フレーム 0（＝参照位置）に置く
 * ので、**あるフレームの失敗が次のフレームへ伝播しない**。
 */
export function trackTemplate(
  frames: readonly Float32Array[],
  width: number,
  height: number,
  roi: PixelRect,
  opts: TrackOptions = {},
): TrackResult {
  return trackPrepared(prepareFrames(frames, width, height, opts), roi, opts);
}

/**
 * 前処理（対数 → 平滑化 → 勾配 → ピラミッド）を済ませたフレーム列。
 *
 * <p>🚨 **ROI を変えるたびに前処理をやり直さないために分けてある。**
 * {@link suggestTrackingRois} は候補ごとに追尾するので、素直に書くと同じフレームの
 * ぼかしと Sobel を候補の数だけ繰り返す。実データ（512²・16 枚・候補 8 個）で
 * **十数秒**になる計算量で、Worker に載せても遅い。
 */
export interface PreparedFrames {
  pyramids: Level[][];
  referenceFrame: number;
  width: number;
  height: number;
  /** 参照フレームの平滑化像の勾配（構造テンソル用。勾配強度ではなく**成分**）。 */
  refGx: Float32Array;
  refGy: Float32Array;
}

/** {@link prepareFrames} に効く設定（ROI に依らないもの）。 */
export type PrepareOptions = Pick<TrackOptions, "referenceFrame" | "pyramidLevels" | "logarithmic" | "useGradient">;

/** フレーム列の前処理。結果は {@link trackPrepared} へ何度でも渡せる。 */
export function prepareFrames(
  frames: readonly Float32Array[],
  width: number,
  height: number,
  opts: PrepareOptions = {},
): PreparedFrames {
  const reference = Math.max(0, Math.min(frames.length - 1, Math.floor(opts.referenceFrame ?? 0)));
  const levels = Math.max(1, Math.floor(opts.pyramidLevels ?? 3));
  const logarithmic = opts.logarithmic ?? false;
  const useGradient = opts.useGradient ?? true;

  if (!frames.length || width <= 0 || height <= 0) {
    return {
      pyramids: [],
      referenceFrame: reference,
      width,
      height,
      refGx: new Float32Array(0),
      refGy: new Float32Array(0),
    };
  }

  // ROI が追尾に向いているかは**生画像の勾配**で測る（勾配強度像を入れると勾配の勾配になる）。
  const refSmooth = smoothFrame(frames[reference], width, height, logarithmic);
  const refGrad = sobelGradients(refSmooth, width, height);

  const featureOf = (f: Float32Array): Level => {
    const s = smoothFrame(f, width, height, logarithmic);
    if (!useGradient) return { data: s, width, height, planes: 1 };
    const g = sobelGradients(s, width, height);
    const data = new Float32Array(g.gx.length * 2);
    data.set(g.gx, 0);
    data.set(g.gy, g.gx.length);
    return { data, width, height, planes: 2 };
  };

  const pyramids = frames.map((f) => buildPyramid(featureOf(f), levels));
  return { pyramids, referenceFrame: reference, width, height, refGx: refGrad.gx, refGy: refGrad.gy };
}

/** 昇順に並べた配列からの分位点（線形補間はしない。要素数が少ないので素直に取る）。 */
function quantileSorted(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function medianOf(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}

/**
 * 🔴 **軌跡の広がりは RMS ではなく分位点で測る**（既定 p75）。
 *
 * <p>RMS は 2 乗和なので**外れ値 1 点に支配される**。実機（Rubo Run1・タイル 256,352）で、
 * 33 枚中 32 枚が ±0.14px しか動いていないのに 1 枚の追尾ミス (−15.51, +7.69) だけで
 * RMS が **4.97px** になり、本当に動く ROI（実測 8.78px）を押しのけて 1 位を取った。
 *
 * <p>中央値を中心に取り、そこからの距離の分位点を返す。`reliable:false` のフレームは見ない。
 *
 * @param axis 与えると**その方向へ射影してから**測る。
 *   🚨 アパーチャ問題の ROI は「動いている」ように見えるが、その動きは**帯に沿う向き**＝
 *   勾配の弱い向きにしか出ない（像が変わらないので相関が落ちず、探索窓の中を滑る）。
 *   構造テンソルの主方向（＝勾配の強い向き）へ射影すると、この偽の動きは**消える**。
 *   合成データで、縞だけの領域が「動き 15.3px」と出て 1 位を取っていたのがこれである。
 */
export function trajectorySpread(
  frames: readonly TrackedFrame[],
  quantile = 0.75,
  axis?: readonly [number, number],
): number {
  const good = frames.filter((f) => f.reliable);
  const use = good.length >= 2 ? good : frames;
  if (use.length < 2) return 0;
  if (axis) {
    const len = Math.hypot(axis[0], axis[1]);
    if (len > 1e-12) {
      const ax = axis[0] / len;
      const ay = axis[1] / len;
      const proj = use.map((f) => f.dx * ax + f.dy * ay);
      const m = medianOf(proj);
      const d = proj.map((v) => Math.abs(v - m)).sort((a, b) => a - b);
      return quantileSorted(d, quantile);
    }
  }
  const mx = medianOf(use.map((f) => f.dx));
  const my = medianOf(use.map((f) => f.dy));
  const d = use.map((f) => Math.hypot(f.dx - mx, f.dy - my)).sort((a, b) => a - b);
  return quantileSorted(d, quantile);
}

/**
 * 時間方向の外れフレームに印を付ける（**その場で書き換える**）。
 *
 * <p>各フレームを**前後 2 枚の中央値**と比べ、乖離が「乖離の中央値 + factor×MAD」を超えたら
 * `reliable:false` にする。滑らかに動く ROI では乖離が揃うので MAD が効いて誤検出しにくく、
 * 1 枚だけ飛ぶ追尾ミスは中央値から大きく外れるので確実に落ちる。
 */
function markTemporalOutliers(frames: TrackedFrame[], factor: number, minDistancePx: number): void {
  const n = frames.length;
  if (factor <= 0 || n < 5) return;
  const dev: number[] = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = t - 2; k <= t + 2; k++) {
      if (k === t || k < 0 || k >= n) continue;
      xs.push(frames[k].dx);
      ys.push(frames[k].dy);
    }
    if (xs.length < 2) continue;
    dev[t] = Math.hypot(frames[t].dx - medianOf(xs), frames[t].dy - medianOf(ys));
  }
  const center = medianOf(dev);
  const spread = medianOf(dev.map((d) => Math.abs(d - center)));
  const limit = Math.max(center + factor * spread, minDistancePx);
  for (let t = 0; t < n; t++) {
    if (frames[t].reliable && dev[t] > limit) {
      frames[t].reliable = false;
      frames[t].reason = "outlier";
    }
  }
}

/** 前処理済みのフレーム列に対して 1 つの ROI を追尾する。 */
export function trackPrepared(
  prepared: PreparedFrames,
  roi: PixelRect,
  opts: TrackOptions = {},
): TrackResult {
  const { width, height, referenceFrame: reference, pyramids } = prepared;
  const searchRadius = Math.max(1, Math.floor(opts.searchRadius ?? 32));
  const minScore = opts.minScore ?? 0.5;
  const minAnisotropy = opts.minAnisotropy ?? 0.04;

  const empty: TrackResult = {
    frames: [],
    referenceFrame: reference,
    tensor: { lambda1: 0, lambda2: 0, anisotropy: 0, orientationRad: 0 },
    reliable: false,
    reason: "noTexture",
  };
  if (!pyramids.length || width <= 0 || height <= 0) return empty;

  const tensor = structureTensorFromGradients(prepared.refGx, prepared.refGy, width, height, roi);

  const refPyramid = pyramids[reference];
  const templates = refPyramid.map((lv, i) => {
    const scale = 1 << i;
    return extractTemplate(lv, {
      x0: roi.x0 / scale,
      y0: roi.y0 / scale,
      x1: roi.x1 / scale,
      y1: roi.y1 / scale,
    });
  });

  const out: TrackedFrame[] = [];
  for (let t = 0; t < pyramids.length; t++) {
    const pyramid = pyramids[t];

    let cx = 0;
    let cy = 0;
    let atEdge = false;
    for (let L = pyramid.length - 1; L >= 0; L--) {
      const scale = 1 << L;
      const coarsest = L === pyramid.length - 1;
      const radius = coarsest ? Math.max(1, Math.ceil(searchRadius / scale)) : 2;
      let best = -Infinity;
      let bu = cx;
      let bv = cy;
      for (let v = cy - radius; v <= cy + radius; v++) {
        for (let u = cx - radius; u <= cx + radius; u++) {
          const s = znccAt(templates[L], pyramid[L], u, v);
          if (s > best) { best = s; bu = u; bv = v; }
        }
      }
      if (coarsest) {
        atEdge = Math.abs(bu - cx) >= radius || Math.abs(bv - cy) >= radius;
      }
      cx = bu;
      cy = bv;
      if (L > 0) { cx *= 2; cy *= 2; }
    }

    // 最終段で 2 次曲面によるサブピクセル（3×3 の相関値を使う）。
    const lv0 = pyramid[0];
    const tp0 = templates[0];
    const g: number[][] = [];
    for (let dv = -1; dv <= 1; dv++) {
      const row: number[] = [];
      for (let du = -1; du <= 1; du++) row.push(znccAt(tp0, lv0, cx + du, cy + dv));
      g.push(row);
    }
    const c = g[1][1];
    const peak = quadraticPeak2d(g);

    let reason: TrackedFrame["reason"];
    if (c < minScore) reason = "lowScore";
    else if (peak === null) reason = "flatPeak";
    else if (atEdge) reason = "atSearchEdge";

    out.push({
      dx: cx + (peak?.du ?? 0),
      dy: cy + (peak?.dv ?? 0),
      score: c,
      reliable: reason === undefined,
      ...(reason ? { reason } : {}),
    });
  }

  markTemporalOutliers(out, opts.outlierFactor ?? 6, opts.minOutlierDistancePx ?? 0.5);

  const reliableCount = out.filter((f) => f.reliable).length;
  let reason: TrackResult["reason"];
  if (tensor.lambda1 <= 1e-20) reason = "noTexture";
  else if (tensor.anisotropy < minAnisotropy) reason = "aperture";
  else if (reliableCount < Math.max(2, Math.ceil(out.length * 0.5))) reason = "tooFewReliableFrames";

  return {
    frames: out,
    referenceFrame: reference,
    tensor,
    reliable: reason === undefined,
    ...(reason ? { reason } : {}),
  };
}

/**
 * 前処理済みの 2 枚を、**サブピクセルでずらして** ROI の中だけ ZNCC で比べる。
 *
 * <p>同位相マスクの候補を「振幅で k 個に絞ったあと**画像で 1 個に決める**」ために要る
 * （`fw/angio-design.md` §6.7）。`a[aIndex]` の ROI を切り出し、`b[bIndex]` の同じ位置から
 * `(dx, dy)` ずらした窓と比べる（`(dx,dy)` は**マスクをどれだけ動かすと合うか**）。
 *
 * <p>🔴 **比べるのは勾配成分（`prepareFrames` の既定）であって生画素ではない。** 造影で
 * 背景の明るさがゆっくり変わっても効くようにするため。`a` と `b` は**同じ設定で前処理**
 * されていること（片方だけ生画素だと相関に意味が無い）。
 *
 * <p>⚠️ 比べる範囲は ROI の中だけである。ROI は「造影で変わらない場所」として選んである
 * （{@link suggestTrackingRois}）ので、これがそのまま**血管を除いた類似度**になる。
 * 逆に言えば、**ROI の外がどれだけ合っているかは見ていない**。
 */
export function znccPrepared(
  a: PreparedFrames,
  aIndex: number,
  b: PreparedFrames,
  bIndex: number,
  roi: PixelRect,
  dx: number,
  dy: number,
): number {
  const la = a.pyramids[aIndex]?.[0];
  const lb = b.pyramids[bIndex]?.[0];
  if (!la || !lb) return 0;
  if (la.width !== lb.width || la.height !== lb.height || la.planes !== lb.planes) return 0;
  const r = clampRect(roi, la.width, la.height);
  const tw = r.x1 - r.x0 + 1;
  const th = r.y1 - r.y0 + 1;
  const n = tw * th * la.planes;
  if (n < 2) return 0;

  let sA = 0, sB = 0, sAA = 0, sBB = 0, sAB = 0;
  for (let p = 0; p < la.planes; p++) {
    const plane = p * la.width * la.height;
    for (let j = 0; j < th; j++) {
      const rowA = plane + (r.y0 + j) * la.width;
      for (let i = 0; i < tw; i++) {
        const va = la.data[rowA + r.x0 + i];
        const vb = sampleBilinearPlane(lb, plane, r.x0 + i + dx, r.y0 + j + dy);
        sA += va; sB += vb;
        sAA += va * va; sBB += vb * vb; sAB += va * vb;
      }
    }
  }
  const ma = sA / n;
  const mb = sB / n;
  const cov = sAB - n * ma * mb;
  const den = Math.sqrt((sAA - n * ma * ma) * (sBB - n * mb * mb));
  return den > 1e-12 ? cov / den : 0;
}

/** 1 チャンネルぶんの双線形サンプリング（範囲外は端の値）。 */
function sampleBilinearPlane(level: Level, planeOffset: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x0c = clampIndex(x0, level.width - 1);
  const x1c = clampIndex(x0 + 1, level.width - 1);
  const y0c = clampIndex(y0, level.height - 1) * level.width;
  const y1c = clampIndex(y0 + 1, level.height - 1) * level.width;
  const v00 = level.data[planeOffset + y0c + x0c];
  const v01 = level.data[planeOffset + y0c + x1c];
  const v10 = level.data[planeOffset + y1c + x0c];
  const v11 = level.data[planeOffset + y1c + x1c];
  const top = v00 + (v01 - v00) * fx;
  const bottom = v10 + (v11 - v10) * fx;
  return top + (bottom - top) * fy;
}

/* ------------------------------------------------------------------ */
/* エッジ像での剛体合わせ（DSA の体動補正）                              */
/* ------------------------------------------------------------------ */

export interface EdgeAlignOptions {
  /** 合わせに使う範囲。省略時は画像全体を少し内側へ寄せた矩形。 */
  roi?: PixelRect;
  /** 探索半径 [px]（既定 8。`fw/angio-design.md` §6.4 と同じ）。 */
  searchRadius?: number;
  logarithmic?: boolean;
  /**
   * 回転も探す幅 [度]。**既定 0 ＝平行移動だけ**。
   * 🔴 自由度を上げるほど「片方にしか無いもの」を変形で埋めにいく
   * （`fw/subtraction-design.md` §2.3）。明示的に指定したときだけ回す。
   */
  maxRotationDeg?: number;
  /** 回転の刻み [度]（既定 0.5）。 */
  rotationStepDeg?: number;
  minScore?: number;
}

export interface EdgeAlignResult {
  /** マスクをこれだけ動かすと合う [px]。 */
  dx: number;
  dy: number;
  /** 画像中心まわりに回す量 [度]（`maxRotationDeg` が 0 なら常に 0）。 */
  rotationDeg: number;
  /** そのときの ZNCC。 */
  score: number;
  reliable: boolean;
  reason?: TrackedFrame["reason"] | TrackResult["reason"];
}

/**
 * **エッジ像でマスクとライブを剛体で合わせる**（`fw/angio-design.md` §6.7・A16 Phase 3）。
 *
 * <p>🔴 **返すのは「どれだけ動かすか」だけ。** 求めた変位は**オリジナルのマスク**に当てて引く
 * （エッジ像を引いてはいけない——エッジ像の差分は血管の輪郭であって血管ではない）。
 *
 * <p>🔴 **`dsa.ts:estimateShift()` の置き換えではない。** あちらは差分の背景 RMS を最小化する。
 * マスクとライブの輝度スケールが揃っているとき（＝同一収集の体動補正）は**あちらのほうが正確**
 * （実測 0.000px vs 0.066px）。こちらは ZNCC なので `aI+b` に不変で、**同位相マスクのように
 * 別の心拍・別のランから持ってきたマスク**に強い。用途で選ぶ。
 *
 * <p>回転の探し方は 2 段。**半分の解像度で角度を粗く走査 → 最良角で全解像度の平行移動を詰める**。
 * 全解像度で角度を振ると、角度の数だけ全画面のぼかしと Sobel が走って実用にならない。
 * ⚠️ 半解像度の回転中心は全解像度の中心と 0.25px ずれるが、**最終の平行移動は全解像度で
 * 取り直す**ので効かない。
 */
export function alignOnEdges(
  mask: Float32Array,
  live: Float32Array,
  width: number,
  height: number,
  opts: EdgeAlignOptions = {},
): EdgeAlignResult {
  const searchRadius = Math.max(1, Math.floor(opts.searchRadius ?? 8));
  const logarithmic = opts.logarithmic ?? false;
  const maxRot = Math.max(0, opts.maxRotationDeg ?? 0);
  const step = Math.max(0.05, opts.rotationStepDeg ?? 0.5);
  const inset = searchRadius + 8;
  const roi: PixelRect = opts.roi ?? {
    x0: inset,
    y0: inset,
    x1: width - 1 - inset,
    y1: height - 1 - inset,
  };
  const prepOpts = { logarithmic };

  const translateAt = (m: Float32Array): TrackResult =>
    trackPrepared(prepareFrames([m, live], width, height, prepOpts), roi, {
      searchRadius,
      ...(opts.minScore != null ? { minScore: opts.minScore } : {}),
    });

  let rotationDeg = 0;
  if (maxRot > 0) {
    // 角度の粗探索は半分の解像度で（全解像度で振ると角度の数だけ全画面の前処理が走る）。
    const half = (src: Float32Array) => downsample({ data: src, width, height, planes: 1 });
    const hm = half(mask);
    const hl = half(live);
    const hRoi: PixelRect = { x0: roi.x0 / 2, y0: roi.y0 / 2, x1: roi.x1 / 2, y1: roi.y1 / 2 };
    const hRadius = Math.max(1, Math.ceil(searchRadius / 2));
    const angles: number[] = [];
    for (let a = -maxRot; a <= maxRot + 1e-9; a += step) angles.push(Number(a.toFixed(4)));
    const scores = angles.map((a) => {
      const rot = a === 0 ? hm.data : warpRigid(hm.data, hm.width, hm.height, 0, 0, a);
      const tr = trackPrepared(
        prepareFrames([rot, hl.data], hm.width, hm.height, prepOpts),
        hRoi,
        { searchRadius: hRadius },
      );
      return tr.frames[1]?.score ?? -1;
    });
    let bi = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
    rotationDeg = angles[bi];
    // 角度も放物線で詰める（両隣があるときだけ）。
    if (bi > 0 && bi < angles.length - 1) {
      const d = parabolaPeak(scores[bi - 1], scores[bi], scores[bi + 1]);
      if (d !== null) rotationDeg = angles[bi] + d * step;
    }
  }

  const tr = translateAt(rotationDeg === 0 ? mask : warpRigid(mask, width, height, 0, 0, rotationDeg));
  const f = tr.frames[1];
  if (!f) {
    return { dx: 0, dy: 0, rotationDeg: 0, score: 0, reliable: false, reason: "noTexture" };
  }
  const reason = !tr.reliable ? tr.reason : f.reliable ? undefined : f.reason;
  return {
    dx: f.dx,
    dy: f.dy,
    rotationDeg,
    score: f.score,
    reliable: tr.reliable && f.reliable,
    ...(reason ? { reason } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 軌跡 → 運動信号                                                      */
/* ------------------------------------------------------------------ */

/** 運動信号（1 次元）。 */
export interface MotionSignal {
  /** PCA 主軸への射影 [**px のまま**]。 */
  s: Float64Array;
  /** その時間微分 [px/s]。向き（収縮期／拡張期）の判別に使う。 */
  sdot: Float64Array;
  /** 射影に使った主軸（単位ベクトル）。 */
  axis: readonly [number, number];
  /** 射影の原点（軌跡の平均位置）。 */
  center: readonly [number, number];
  reliable: boolean;
  /**
   * 🔴 **デトレンドで実際に行ったこと。** `"none"` は「**呼吸が残っている**」という意味。
   *
   * <p>以前はここが黙っていたため、窓がフレーム数以上で移動平均が素通りしていても
   * 呼び出し側から分からなかった（§6.15）。**何もしなかったことも結果として返す。**
   */
  detrendMode: DetrendMode;
  /** `"movingAverage"` のときの窓 [フレーム]。`"linear"` / `"none"` では 0。 */
  detrendWindowFrames: number;
  /** `"none"` になった理由（診断用）。 */
  detrendSkipped?: DetrendSkipReason;
}

/** デトレンドの方式。 */
export type DetrendMode = "movingAverage" | "linear" | "none";

/** デトレンドしなかった理由。 */
export type DetrendSkipReason = "requestedOff" | "noTimeBase" | "tooFewFrames";

export interface MotionSignalOptions {
  /**
   * 主軸を外から与える。🔴 **2 ラン間で振幅を比べるときは必ず同じ軸を使う**
   * （マスク側で求めた `axis` をライブ側へ渡す）。軸が違うと px の値が比較できない。
   */
  axis?: readonly [number, number];
  /**
   * デトレンドの窓 [フレーム]。既定は **1.5 秒相当**（HR 40 bpm ＝ 心拍の下限の周期）。
   * 周期を知らなくても決まる規則にしてある。0 でデトレンドしない。
   *
   * <p>`detrendMode` が `"movingAverage"` のときだけ効く（`"auto"` で移動平均が選ばれた
   * ときを含む）。
   */
  detrendWindowFrames?: number;
  /**
   * デトレンドの方式。既定は `"auto"`（記録長で決める。{@link planDetrend}）。
   *
   * <p>🔴 **2 ラン間で振幅を比べるときは、`axis` と同じく必ず揃える**
   * ——マスク側で決まった方式と窓をライブ側へ渡すこと。片方が移動平均でもう片方が線形だと、
   * 残る振幅の定義が違うので amplitude sorting の前提が壊れる。
   */
  detrendMode?: "auto" | DetrendMode;
}

/** デトレンドの決定。{@link planDetrend} が返し、{@link applyDetrend} が実行する。 */
interface DetrendPlan {
  mode: DetrendMode;
  windowFrames: number;
  skipped?: DetrendSkipReason;
}

/**
 * **何でデトレンドするかを決める。**
 *
 * <p>🔴 判断はここ 1 箇所に集める。以前は `detrend()` の中で `w >= s.length` を
 * **黙って素通り**していたため、呼び出し側からは「引いたのか引いていないのか」が分からなかった。
 */
function planDetrend(
  n: number,
  dtMs: number,
  opts: MotionSignalOptions,
): DetrendPlan {
  const requested = opts.detrendMode ?? "auto";
  if (requested === "none") return { mode: "none", windowFrames: 0, skipped: "requestedOff" };
  // 🔴 `detrendWindowFrames: 0` ＝「引かない」の既存の意味は変えない。
  if (opts.detrendWindowFrames === 0) return { mode: "none", windowFrames: 0, skipped: "requestedOff" };
  if (n < 3) return { mode: "none", windowFrames: 0, skipped: "tooFewFrames" };
  if (!(dtMs > 0)) return { mode: "none", windowFrames: 0, skipped: "noTimeBase" };

  if (requested === "linear") return { mode: "linear", windowFrames: 0 };

  const window = Math.floor(opts.detrendWindowFrames ?? Math.round(MAX_PERIOD_MS / dtMs));
  const movingAverage = (): DetrendPlan =>
    window >= 3 && window < n
      ? { mode: "movingAverage", windowFrames: window }
      : { mode: "none", windowFrames: 0, skipped: "tooFewFrames" };

  // 窓を明示されたら方式も決まったものとして扱う（従来の呼び出しの意味を変えない）。
  if (requested === "movingAverage" || opts.detrendWindowFrames != null) return movingAverage();

  // ── requested === "auto" ────────────────────────────────────────
  // 🔑 **移動平均は、記録が「最も遅い心拍の周期」の 2 倍以上あるときだけ使える。**
  //
  // <p>移動平均は心拍そのものは削らない（窓 31・周期 16.6 で残存 1.07）。問題は**端**で、
  // 実装が窓を縮めるせいで **純粋な直線トレンドを 48% 残す**。呼吸を落とすのが目的なのに
  // 一次成分が半分残るなら意味がない。1.28 秒の窓での実測（心拍 T=16.6・呼吸 T=100）:
  //
  // <pre>
  //             心拍残存  呼吸残存  判別比  純ランプ残り
  //   生          1.000    1.000     2.0      1.000
  //   移動平均31   1.021    0.537     3.8      0.480   ← 呼吸が落ちない
  //   線形        0.950    0.247     7.7      0.000
  // </pre>
  //
  // <p>短い窓では呼吸（3〜5 秒周期）はほぼ直線に見えるので、直線を引けば消える。
  // 🔴 **`min(n-1, …)` のようなクランプは入れない**——窓が心拍の周期より短くなると
  // 今度は心拍を削る側に倒れる（窓 9・周期 16.6 で残存 0.40）。
  //
  // <p>⚠️ **正直な限界**: 40〜50 bpm では窓に 1 周期も入らず、呼吸も心拍もただの「坂」に
  // なるので**どの方式でも分離できない**（線形での心拍残存は 60bpm 0.95 に対し 40bpm 0.64）。
  if (n * dtMs >= 2 * MAX_PERIOD_MS) return movingAverage();
  return { mode: "linear", windowFrames: 0 };
}

/** 移動平均を引く（端は窓を縮める）。 */
function detrendMovingAverage(s: Float64Array, windowFrames: number): Float64Array {
  const w = Math.floor(windowFrames);
  if (w < 3 || w >= s.length) return s;
  const half = w >> 1;
  const out = new Float64Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(s.length - 1, i + half);
    let sum = 0;
    for (let k = a; k <= b; k++) sum += s[k];
    out[i] = s[i] - sum / (b - a + 1);
  }
  return out;
}

/**
 * 最小二乗の直線を引く。
 *
 * <p>🔴 **当てはめは `reliable` なフレームだけ**で行い、引き算は全フレームに適用する
 * （PCA の基底が `used` だけを使うのと同じ作法）。外れフレーム 1 枚で直線が傾くのを防ぐ。
 */
function detrendLinear(s: Float64Array, reliable: readonly boolean[]): Float64Array {
  const n = s.length;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (reliable[i]) idx.push(i);
  const fit = idx.length >= 2 ? idx : Array.from({ length: n }, (_, i) => i);

  let sx = 0, sy = 0;
  for (const i of fit) { sx += i; sy += s[i]; }
  const mx = sx / fit.length;
  const my = sy / fit.length;
  let sxx = 0, sxy = 0;
  for (const i of fit) {
    const a = i - mx;
    sxx += a * a;
    sxy += a * (s[i] - my);
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = s[i] - (my + slope * (i - mx));
  return out;
}

function applyDetrend(s: Float64Array, plan: DetrendPlan, reliable: readonly boolean[]): Float64Array {
  if (plan.mode === "movingAverage") return detrendMovingAverage(s, plan.windowFrames);
  if (plan.mode === "linear") return detrendLinear(s, reliable);
  return s;
}

function meanFrameIntervalMs(frameStartTimesMs: readonly number[]): number {
  if (frameStartTimesMs.length < 2) return 0;
  const span = frameStartTimesMs[frameStartTimesMs.length - 1] - frameStartTimesMs[0];
  return span / (frameStartTimesMs.length - 1);
}

/**
 * 軌跡を 1 次元の運動信号にする（§3.6）。
 *
 * <p>**PCA で主方向へ落とす。** `dx` か `dy` を決め打つと、投影角度によっては信号が消える。
 * 心臓の面内運動はほぼ直線往復なので第 1 固有ベクトルが自然な軸になる。
 *
 * <p>🔴 **px のまま返す（正規化しない）。** 2 ラン間で振幅を直接比べるのが amplitude sorting の
 * 要点で、ラン内で正規化すると比較できなくなる。
 *
 * <p>⚠️ 原点は**そのランの軌跡の平均**なので、2 ラン間でのゼロ点は「各ランの平均位置」で揃う。
 * 寝台や体位が数 px ずれていてもそれは打ち消されるが、**ランが 1 周期に満たない**と平均が
 * 偏る。残る数 px のずれは Phase 3 の剛体合わせが吸収する前提。
 */
export function motionSignal(
  track: TrackResult,
  frameStartTimesMs: readonly number[],
  opts: MotionSignalOptions = {},
): MotionSignal {
  const n = track.frames.length;
  const s = new Float64Array(n);
  const sdot = new Float64Array(n);
  if (n === 0) {
    return {
      s, sdot, axis: [1, 0], center: [0, 0], reliable: false,
      detrendMode: "none", detrendWindowFrames: 0, detrendSkipped: "tooFewFrames",
    };
  }

  const used = track.frames.filter((f) => f.reliable);
  const basis = used.length >= 2 ? used : track.frames;
  let mx = 0, my = 0;
  for (const f of basis) { mx += f.dx; my += f.dy; }
  mx /= basis.length;
  my /= basis.length;

  let axis: readonly [number, number];
  if (opts.axis) {
    const len = Math.hypot(opts.axis[0], opts.axis[1]);
    axis = len > 1e-12 ? [opts.axis[0] / len, opts.axis[1] / len] : [1, 0];
  } else {
    let cxx = 0, cxy = 0, cyy = 0;
    for (const f of basis) {
      const a = f.dx - mx;
      const b = f.dy - my;
      cxx += a * a; cxy += a * b; cyy += b * b;
    }
    const tr = cxx + cyy;
    const diff = Math.sqrt((cxx - cyy) * (cxx - cyy) + 4 * cxy * cxy);
    const lambda1 = (tr + diff) / 2;
    let ex = cxy;
    let ey = lambda1 - cxx;
    if (Math.hypot(ex, ey) < 1e-12) { ex = lambda1 - cyy; ey = cxy; }
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) { ex = 1; ey = 0; }
    axis = len < 1e-12 ? [1, 0] : [ex / len, ey / len];
    // 符号を決め打つ（そうしないとランごとに軸が反転して振幅の比較が壊れる）。
    if (Math.abs(axis[0]) >= Math.abs(axis[1]) ? axis[0] < 0 : axis[1] < 0) {
      axis = [-axis[0], -axis[1]];
    }
  }

  for (let i = 0; i < n; i++) {
    s[i] = (track.frames[i].dx - mx) * axis[0] + (track.frames[i].dy - my) * axis[1];
  }

  const dtMs = meanFrameIntervalMs(frameStartTimesMs);
  const plan = planDetrend(n, dtMs, opts);
  const centered = applyDetrend(s, plan, track.frames.map((f) => f.reliable));
  if (centered !== s) s.set(centered);

  // 中央差分（端は片側差分）。時間は秒。
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const dt = ((frameStartTimesMs[b] ?? b) - (frameStartTimesMs[a] ?? a)) / 1000;
    sdot[i] = dt > 1e-9 ? (s[b] - s[a]) / dt : 0;
  }

  return {
    s, sdot, axis, center: [mx, my],
    reliable: track.reliable && used.length >= 2,
    detrendMode: plan.mode,
    detrendWindowFrames: plan.windowFrames,
    ...(plan.skipped ? { detrendSkipped: plan.skipped } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 周期の推定                                                           */
/* ------------------------------------------------------------------ */

export interface PeriodEstimate {
  periodMs: number;
  periodFrames: number;
  /** 自己相関のピークの高さ。 */
  peakCorrelation: number;
  /**
   * 🔑 **オクターブ補正で周期を半分にした回数**（0〜2）。
   *
   * <p>⚠️ **`confidence` はオクターブ誤りを弾けない。** あれは「ピークが高いか」の指標だが、
   * オクターブ誤りは定義上 `r(2T) ≈ r(T)` で**両方高い**ときに起きる。倍周期にロックしても
   * `confidence` は "ok" のままになる（実機の 45 bpm ＝真値 90.2 の半分がこれ）。
   * 補正が効いたのか、ぎりぎり落ちたのかを外から見るにはこの 2 つが要る。
   */
  octaveHalved: number;
  /**
   * 採用した遅れの**半分**での自己相関。`OCTAVE_TOLERANCE × peakCorrelation` と比べている。
   *
   * <p>🔴 **比べていないときは `null`。** 0 で表すと「測ったら 0 だった」と区別が付かない
   * （実機で `-0.017` を「比べていない」と表示する取り違えを出した）。負の値は正当な測定結果である。
   */
  halfLagCorrelation: number | null;
  confidence: "ok" | "weak" | "none";
  reason?: "tooFewSamplesPerCycle" | "runTooShort" | "noPeak";
}

/**
 * 自己相関で心周期を推定する（§3.7）。
 *
 * <p>探索範囲は生理的な心拍（40〜200 bpm）に限る。フレーム間隔は `xaCineTiming.ts` の
 * `frameStartTimesMs()` から来るので、**可変レート収集（FrameTimeVector）でも秒で扱える**。
 *
 * <p>🔴 1 周期が {@link MIN_FRAMES_PER_CYCLE} フレーム未満なら `confidence:"none"` を返す。
 * 推定して当てにいかない。
 */
export function estimatePeriod(
  s: Float64Array | readonly number[],
  frameStartTimesMs: readonly number[],
): PeriodEstimate {
  const n = s.length;
  const none = (reason: PeriodEstimate["reason"]): PeriodEstimate => ({
    periodMs: 0, periodFrames: 0, peakCorrelation: 0, octaveHalved: 0, halfLagCorrelation: null,
    confidence: "none", ...(reason ? { reason } : {}),
  });
  const dtMs = meanFrameIntervalMs(frameStartTimesMs);
  if (n < 4 || !(dtMs > 0)) return none("runTooShort");

  const minTau = Math.max(2, Math.ceil(MIN_PERIOD_MS / dtMs));
  const maxTau = Math.min(Math.floor(MAX_PERIOD_MS / dtMs), Math.floor(n / 2));
  if (minTau > maxTau) {
    // 1 周期が数フレームしか無い（= dt が大きすぎる）か、ランが 1 周期ぶんも無い。
    return none(MIN_PERIOD_MS / dtMs > n / 2 ? "runTooShort" : "tooFewSamplesPerCycle");
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += s[i];
  mean /= n;

  // 🔴 **半分の遅れまで計算する。** オクターブ補正（下記）で `r[tau/2]` を見るため、
  //    生理的な下限より下も持っておく必要がある。
  const loTau = Math.max(1, Math.floor(minTau / 2) - 1);
  const r = new Float64Array(maxTau + 2);
  for (let tau = loTau; tau <= maxTau + 1 && tau < n; tau++) {
    if (tau < 1) continue;
    let num = 0, va = 0, vb = 0;
    for (let i = 0; i + tau < n; i++) {
      const a = s[i] - mean;
      const b = s[i + tau] - mean;
      num += a * b; va += a * a; vb += b * b;
    }
    const den = Math.sqrt(va * vb);
    r[tau] = den > 1e-12 ? num / den : 0;
  }

  let bestTau = -1;
  let bestR = -Infinity;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (r[tau] > bestR) { bestR = r[tau]; bestTau = tau; }
  }
  if (bestTau < 0 || bestR <= 0) return none("noPeak");

  // 🔴 **オクターブ補正**（倍周期へのロックを外す）。
  //
  // <p>自己相関は `r(2T) ≈ r(T)` になりやすく、**拍ごとに振れ幅が違う**と倍のほうが
  // わずかに高く出る（呼吸で心臓の移動量が変わる実データでは普通に起きる）。
  // 実機（Rubo Run1・137 フレーム・25fps）で **33.1 フレーム＝45 bpm** と出たが、
  // 波形の零交差から読める真値は **14〜20 フレーム＝75〜105 bpm** だった。
  //
  // <p>半分の遅れの相関が「明確に低くない」なら半分を採る。**閾値は半分側に倒す**
  // ——倍にロックすると心拍が半分に見え、位相も全部ずれるのに対し、
  // 逆向きの誤り（本当は倍周期）は現実の心拍ではまず起きない。
  //
  // <p>🔴 **生理的な下限（200 bpm）より下へは降りない。** そこまで行くなら
  // それは心拍ではない。
  let tau = bestTau;
  let octaveHalved = 0;
  let halfLagCorrelation: number | null = null;
  for (let k = 0; k < 2; k++) {
    const half = Math.round(tau / 2);
    if (half < minTau || half < 1) break;
    if (k === 0) halfLagCorrelation = r[half];
    if (!(r[half] > OCTAVE_TOLERANCE * r[tau])) break;
    tau = half;
    octaveHalved++;
  }
  const tauR = r[tau];

  // 放物線でサブフレームまで詰める（両隣がある場合だけ）。
  let refined = tau;
  if (tau - 1 >= 1 && tau + 1 < n) {
    const d = parabolaPeak(r[tau - 1], r[tau], r[tau + 1]);
    if (d !== null) refined = tau + d;
  }

  const periodFrames = refined;
  const periodMs = refined * dtMs;
  let confidence: PeriodEstimate["confidence"] = "ok";
  let reason: PeriodEstimate["reason"];
  if (periodFrames < MIN_FRAMES_PER_CYCLE) { confidence = "none"; reason = "tooFewSamplesPerCycle"; }
  else if (tauR < 0.3) { confidence = "none"; reason = "noPeak"; }
  else if (tauR < 0.5) confidence = "weak";

  return {
    periodMs: confidence === "none" ? 0 : periodMs,
    periodFrames: confidence === "none" ? 0 : periodFrames,
    peakCorrelation: tauR,
    octaveHalved,
    halfLagCorrelation,
    confidence,
    ...(reason ? { reason } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 位相（交差確認用）                                                    */
/* ------------------------------------------------------------------ */

export interface PhaseAssignment {
  /** 各フレームの位相 [0,1)。 */
  phase: Float64Array;
  /** 拾ったピークのフレーム番号。 */
  peaks: number[];
  reliable: boolean;
}

/**
 * ピーク間を**時間で**線形補間して位相を振る（§3.9）。RT 標準の phase sorting と同じ手順。
 *
 * <p>🔴 **これは対応付けの主役ではない。** 心拍数が違うランどうしでは時間割合と位置が一致
 * しないため（RR が延びるのは主に拡張期）、{@link matchByAmplitude} の結果と食い違ったときに
 * 「信頼度を下げる」ためだけに使う。
 */
export function assignPhase(
  s: Float64Array | readonly number[],
  frameStartTimesMs: readonly number[],
  periodFrames: number,
): PhaseAssignment {
  const n = s.length;
  const phase = new Float64Array(n);
  if (n === 0 || !(periodFrames >= MIN_FRAMES_PER_CYCLE)) {
    return { phase, peaks: [], reliable: false };
  }
  const refractory = Math.max(1, Math.floor(0.6 * periodFrames));

  // 極大の候補を値の大きい順に採り、不応期より近いものは捨てる。
  const local: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (s[i] >= s[i - 1] && s[i] > s[i + 1]) local.push(i);
  }
  local.sort((a, b) => s[b] - s[a]);
  const peaks: number[] = [];
  for (const i of local) {
    if (peaks.every((p) => Math.abs(p - i) >= refractory)) peaks.push(i);
  }
  peaks.sort((a, b) => a - b);

  const timeOf = (i: number): number => frameStartTimesMs[i] ?? i;
  if (peaks.length < 2) {
    return { phase, peaks, reliable: false };
  }
  const meanCycleMs = (timeOf(peaks[peaks.length - 1]) - timeOf(peaks[0])) / (peaks.length - 1);
  for (let i = 0; i < n; i++) {
    let k = -1;
    for (let j = 0; j < peaks.length - 1; j++) {
      if (i >= peaks[j] && i < peaks[j + 1]) { k = j; break; }
    }
    if (k >= 0) {
      const t0 = timeOf(peaks[k]);
      const t1 = timeOf(peaks[k + 1]);
      phase[i] = t1 > t0 ? (timeOf(i) - t0) / (t1 - t0) : 0;
    } else {
      // ピークの外側は平均周期で外挿する。
      const anchor = i < peaks[0] ? peaks[0] : peaks[peaks.length - 1];
      const frac = meanCycleMs > 0 ? (timeOf(i) - timeOf(anchor)) / meanCycleMs : 0;
      phase[i] = ((frac % 1) + 1) % 1;
    }
  }
  return { phase, peaks, reliable: true };
}

/* ------------------------------------------------------------------ */
/* 対応付け（主: 振幅＋向き）                                            */
/* ------------------------------------------------------------------ */

export interface MatchOptions {
  /** 返す候補の数（既定 3）。**1 個に決め打たない**——最終選択は画像類似度が決める。 */
  k?: number;
  /** マスク側の振幅範囲をどれだけはみ出してよいか（範囲幅に対する比・既定 0.05）。 */
  coverageTolerance?: number;
  /** 速度 0 とみなす閾値（`max|sdot|` に対する比・既定 0.05）。折り返し点の符号はノイズなので。 */
  velocityEpsFraction?: number;
  /**
   * 範囲外のライブフレームを**振幅の端へ丸めて**候補を作る（既定 false）。
   *
   * <p>🔴 **既定は false のまま。** §3.8 の「カバー外に無理に当てない」は手動経路の作法として
   * 正しく、`xaTracking.test.ts` / `xaPhaseMask.test.ts` がそれを固定している。
   *
   * <p>自動同位相 DSA だけ true にする。理由は実機の落ちどころが悪すぎるため——範囲外にすると
   * `maskAt()` がラン既定のマスクへ落ち、**そのフレームだけ別物の絵**になる。1〜2px の外挿の
   * ほうがはるかにましである。実測（Rubo Run1・正しい ROI）で 12 フレームが最大 1.7px 外側に出た。
   */
  clampOutOfRange?: boolean;
}

export interface MatchCandidate {
  maskFrame: number;
  /** 振幅の差 [px]。小さいほど良い。 */
  cost: number;
}

export interface FrameMatch {
  liveFrame: number;
  /** cost の小さい順。`status:"outOfRange"` のときは空。 */
  candidates: MatchCandidate[];
  /** `"clamped"` は振幅の端へ丸めて当てたもの＝**外挿**であることを意味する。 */
  status: "ok" | "directionRelaxed" | "outOfRange" | "clamped";
}

function signWithEps(v: number, eps: number): number {
  if (Math.abs(v) < eps) return 0;
  return v > 0 ? 1 : -1;
}

function maxAbs(a: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
}

/**
 * 振幅＋運動の向きでフレームを対応付ける（§3.8・**本モジュールの主役**）。
 *
 * <p>ライブのフレーム `t` に対し、`|s_mask − s_live|` が小さく、かつ
 * `sign(sdot)` が一致するマスクフレームを `k` 個返す。
 *
 * <p>⚠️ **振幅だけでは収縮期と拡張期が同値になる**（同じ位置を行きと帰りで 2 回通る）。
 * 向きを添えて初めて一意に決まる。折り返し点では速度が 0 に近く符号がノイズなので、
 * `velocityEpsFraction` 以下は「どちらとも一致する」扱いにする。
 *
 * <p>🔴 **マスク側の振幅範囲がライブを覆っていないフレームは `outOfRange` を返し、候補を出さない。**
 * いちばん近いものを無理に当てると、外挿した誤差がそのまま二重像になる。
 *
 * <p>🔴 2 つの信号は**同じ ROI・同じ軸**で作られていること（{@link MotionSignalOptions#axis}）。
 */
export function matchByAmplitude(
  mask: Pick<MotionSignal, "s" | "sdot">,
  live: Pick<MotionSignal, "s" | "sdot">,
  opts: MatchOptions = {},
): FrameMatch[] {
  const k = Math.max(1, Math.floor(opts.k ?? 3));
  const coverageTolerance = opts.coverageTolerance ?? 0.05;
  const velFrac = opts.velocityEpsFraction ?? 0.05;

  const out: FrameMatch[] = [];
  const m = mask.s.length;
  if (m === 0) {
    for (let t = 0; t < live.s.length; t++) out.push({ liveFrame: t, candidates: [], status: "outOfRange" });
    return out;
  }

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < m; i++) { lo = Math.min(lo, mask.s[i]); hi = Math.max(hi, mask.s[i]); }
  const tol = coverageTolerance * Math.max(1e-9, hi - lo);
  const maskEps = velFrac * maxAbs(mask.sdot);
  const liveEps = velFrac * maxAbs(live.sdot);

  for (let t = 0; t < live.s.length; t++) {
    const raw = live.s[t];
    const outside = raw < lo - tol || raw > hi + tol;
    if (outside && !opts.clampOutOfRange) {
      out.push({ liveFrame: t, candidates: [], status: "outOfRange" });
      continue;
    }
    // 🔑 クランプしても**順位は変わらない**。マスク側の値は全部 [lo,hi] にあるので、
    //    範囲外の `raw` からの距離の順序と、端へ丸めた値からの距離の順序は一致する。
    //    だから `cost` は丸めずに測る——**外挿した量をそのまま数字に残すため**。
    const target = raw;
    const want = signWithEps(live.sdot[t], liveEps);
    const rank = (requireDirection: boolean): MatchCandidate[] => {
      const list: MatchCandidate[] = [];
      for (let i = 0; i < m; i++) {
        if (requireDirection) {
          const got = signWithEps(mask.sdot[i], maskEps);
          if (want !== 0 && got !== 0 && got !== want) continue;
        }
        list.push({ maskFrame: i, cost: Math.abs(mask.s[i] - target) });
      }
      // 同点は若いフレーム優先（決定性★。実行ごとに答えが変わらないように）。
      list.sort((a, b) => (a.cost - b.cost) || (a.maskFrame - b.maskFrame));
      return list.slice(0, k);
    };
    const strict = rank(true);
    const candidates = strict.length ? strict : rank(false);
    const status: FrameMatch["status"] = outside
      ? "clamped"
      : strict.length
        ? "ok"
        : "directionRelaxed";
    out.push({ liveFrame: t, candidates, status });
  }
  return out;
}

/**
 * 運動信号の**広がり**（既定 p10–p90）[px]。`frames` を与えるとその部分集合だけ見る。
 *
 * <p>🔴 **これが小さいと、振幅で並べ替えても意味がない。** 実機（Rubo Run1）で自動採用された
 * ROI の広がりは **0.49px** ＝ 追尾ノイズそのもので、{@link MatchOptions#coverageTolerance}
 * 5% が **0.025px** になり、**0.016px のはみ出し**でマスクを拒否していた。それでも
 * 「同位相マスク」と名乗ってしまうのがいちばん悪い。呼び出し側はこの値で足切りすること。
 */
export function amplitudeSpan(
  s: Float64Array | readonly number[],
  frames?: readonly number[],
  lowQuantile = 0.1,
): number {
  const idx = frames ?? Array.from({ length: s.length }, (_, i) => i);
  const v = idx.filter((i) => i >= 0 && i < s.length).map((i) => s[i]).sort((a, b) => a - b);
  if (v.length < 4) return 0;
  return quantileSorted(v, 1 - lowQuantile) - quantileSorted(v, lowQuantile);
}

/* ------------------------------------------------------------------ */
/* ROI の自動候補                                                       */
/* ------------------------------------------------------------------ */

export interface RoiSuggestOptions {
  /** タイルの一辺 [px]（既定 64）。{@link RoiSuggestOptions#tileSizes} を渡すと無視される。 */
  tileSize?: number;
  /**
   * 複数のタイルサイズを同じ土俵で採点する。
   *
   * <p>🚨 **大きさひとつでは見つからない。** 実機（Rubo Run1）で、心拍を運んでいる領域は
   * **48px のタイルでのみ**見つかった（振幅 29.4px・89bpm）。同じ場所を 64px で切ると
   * 周りの静止した構造が混ざって振幅が 0.1px 級に埋もれる。
   */
  tileSizes?: readonly number[];
  /** タイルの間隔 [px]（既定 = tileSize/2）。 */
  stride?: number;
  /**
   * 追尾まで試す候補の数（既定 24）。
   *
   * <p>🚨 **8 では足りない。** 粗採点は構造の等方性しか見ないので、**本当に動いている領域
   * （心臓の辺縁・カテーテル＝一方向の縁）は上位に来ない**。実機で、振幅 29.4px を持つ
   * タイルが anisotropy 0.23 のために上位 8 から漏れ、振幅 0.49px の静止タイルが採用された。
   */
  shortlist?: number;
  /** 返す候補の数（既定 5）。 */
  maxCandidates?: number;
  referenceFrame?: number;
  logarithmic?: boolean;
  /** ちょうど 0 の画素（コリメータ外）がこの割合を超えるタイルは捨てる（既定 0.01）。 */
  maxZeroFraction?: number;
  /**
   * 画像の縁からこれだけ内側に入っていないタイルは候補にしない [px]（既定 = tileSize/2）。
   *
   * <p>🚨 **縁のタイルは「動いている」と嘘をつく。** 窓が画像の外へ出ると端の値を複製して
   * 埋めるので、**ずらしても像が変わらず相関が落ちない**。実機（Rubo Run1）で、上端の
   * タイル (96,0)–(159,63) が「動き 9.9px」と出て、本来より良い中腹のタイル
   * （λ2/λ1 0.61・動き 6.7px）を押しのけて 1 位になった。追尾しても周期が出ず bpm が空になる。
   */
  borderMargin?: number;
  /**
   * 各フレームの開始時刻 [ms]。**渡すと採点が「心拍帯の動き」に変わる**。
   *
   * <p>🚨 **生の軌跡の広がりで順位を付けてはいけない。** 心臓 XA には**呼吸と拍動という
   * 別々の運動が重なっている**。横隔膜は呼吸で大きく動くので生の広がりでは勝つが、
   * 合わせたいのは**心臓の形と冠動脈**であって横隔膜ではない（利用者の指摘・2026-09-21）。
   * 時刻を渡すと {@link motionSignal} のデトレンド（呼吸性ドリフトの除去）を通した信号で
   * 測り、さらに {@link estimatePeriod} が生理的な周期を返すことを条件にする。
   */
  frameStartTimesMs?: readonly number[];
  /** 追尾の設定（`searchRadius` などを絞ると速い）。 */
  track?: TrackOptions;
}

export interface RoiCandidate {
  rect: PixelRect;
  /** 総合点（大きいほど良い）。 */
  score: number;
  anisotropy: number;
  lambda1: number;
  /** 先頭フレームからの暗化（造影の流入）の大きさ。**大きいほど不適**。 */
  contrastChange: number;
  /**
   * 追尾した軌跡の広がり [px]（**中央値からの距離の p75**）。0 に近いと位相信号が取れない。
   * 🔴 RMS ではない理由は {@link trajectorySpread} を見ること。
   */
  motionPx: number;
  /** 心拍の周期 [フレーム]（`frameStartTimesMs` を渡したときのみ。出せなければ null）。 */
  periodFrames: number | null;
  /** 画像由来の心拍 [bpm]（同上）。 */
  bpm: number | null;
  /** タイルの一辺 [px]（複数サイズを混ぜて採点するので候補ごとに持つ）。 */
  tileSize: number;
  /** 追尾できたフレーム数 / 全フレーム数。 */
  trackedFrames: number;
  totalFrames: number;
  /** 追尾中の ZNCC の平均。 */
  trackScore: number;
}

/**
 * 追尾に向いた ROI の**候補**を出す（§3.5）。
 *
 * <p>🔴 **提案であって決定ではない。** 最終的に追う場所は利用者が決める
 * （§24.1 の TIMI フレームカウントで「全自動検出をやらない」と決めた作法に揃える）。
 *
 * <p>採点は 2 段。①全タイルを構造テンソルと造影の流入で粗く採点 → ②上位だけ実際に追尾して
 * 「本当に追えるか・動いているか」で並べ直す。全タイルを追尾すると 512² で数百タイル ×
 * 全フレームになり実用にならない。
 */export function suggestTrackingRois(
  frames: readonly Float32Array[],
  width: number,
  height: number,
  opts: RoiSuggestOptions = {},
): RoiCandidate[] {
  if (!frames.length) return [];
  const sizes = (opts.tileSizes?.length ? [...opts.tileSizes] : [opts.tileSize ?? 64])
    .map((v) => Math.max(8, Math.floor(v)))
    .filter((v, i, a) => a.indexOf(v) === i && v <= Math.min(width, height));
  if (!sizes.length) return [];
  const shortlist = Math.max(1, Math.floor(opts.shortlist ?? 24));
  const maxCandidates = Math.max(1, Math.floor(opts.maxCandidates ?? 5));
  const reference = Math.max(0, Math.min(frames.length - 1, Math.floor(opts.referenceFrame ?? 0)));
  const logarithmic = opts.logarithmic ?? false;
  const maxZeroFraction = opts.maxZeroFraction ?? 0.01;
  const minAnisotropy = opts.track?.minAnisotropy ?? 0.04;
  // 🚨 **長さが違ったら黙って降格しない（§6.15）。**
  //
  // <p>ここは以前 `?.length === frames.length ? … : null` で、**不一致なら黙って時刻を
  // 捨てていた**。呼び出し側が画素と時刻を別々の式から作っていたため実際に常に不一致で、
  // §6.11.3 で入れた「心拍帯で採点する」対策が一度も実行されていなかった。
  //
  // <p>🔴 **表示が崩れるのではなく、追う場所が変わる**——呼吸で動く横隔膜を心臓として
  // 採用してしまう。静かに劣化させてよい種類の食い違いではない。Worker の `catch` が
  // `{type:"error"}` にして画面まで運ぶので、気づける形で落とす。
  const timesOpt = opts.frameStartTimesMs;
  if (timesOpt && timesOpt.length > 0 && timesOpt.length !== frames.length) {
    throw new Error(
      `suggestTrackingRois: frameStartTimesMs length ${timesOpt.length} !== frames ${frames.length}`,
    );
  }
  const times = timesOpt && timesOpt.length === frames.length ? timesOpt : null;

  // 🚨 前処理は **1 回だけ**。候補ごとに `trackTemplate` を呼ぶと、同じフレームの
  //    ぼかしと Sobel を候補の数だけ繰り返すことになる（実データで十数秒）。
  const prepared = prepareFrames(frames, width, height, {
    referenceFrame: reference,
    logarithmic,
    ...opts.track,
  });
  const gx = prepared.refGx;
  const gy = prepared.refGy;

  interface Coarse { rect: PixelRect; tileSize: number; tensor: StructureTensor; contrastChange: number; coarse: number }
  const coarse: Coarse[] = [];

  for (const tileSize of sizes) {
    const stride = Math.max(4, Math.floor(opts.stride ?? tileSize / 2));
    const borderMargin = Math.max(0, Math.floor(opts.borderMargin ?? tileSize / 2));
    for (let y0 = 0; y0 + tileSize <= height; y0 += stride) {
      for (let x0 = 0; x0 + tileSize <= width; x0 += stride) {
        const rect: PixelRect = { x0, y0, x1: x0 + tileSize - 1, y1: y0 + tileSize - 1 };

        // 🚨 縁のタイルは候補にしない（窓が画像の外へ出ると端を複製して「動かない」ので、
        //    ずらしても相関が落ちず、偽の動きが大きく出る）。
        if (rect.x0 < borderMargin || rect.y0 < borderMargin
          || rect.x1 > width - 1 - borderMargin || rect.y1 > height - 1 - borderMargin) continue;

        // コリメータの外（ちょうど 0）を含むタイルは捨てる。
        // 🚨 除外しないと、値 0 の一様な領域が「動かない・相関が高い」ので上位に来る
        //    （`dsa.ts:contrastSignal()` が 0 を除外しているのと同じ理由）。
        let zeros = 0;
        let sum0 = 0;
        let sumSq0 = 0;
        let count = 0;
        for (let y = rect.y0; y <= rect.y1; y++) {
          const row = y * width;
          for (let x = rect.x0; x <= rect.x1; x++) {
            const v = frames[reference][row + x];
            if (v === 0) zeros++;
            sum0 += v;
            sumSq0 += v * v;
            count++;
          }
        }
        if (zeros / count > maxZeroFraction) continue;
        const mean0 = sum0 / count;
        const sd0 = Math.sqrt(Math.max(0, sumSq0 / count - mean0 * mean0));

        // 造影の流入＝先頭フレームより暗くなる量の最大（タイル平均で見る）。
        // あわせて**時間方向の動き**も測る（下の activity）。どちらも同じ走査で出せる。
        let drop = 0;
        let activity = 0;
        let activityFrames = 0;
        for (let t = 0; t < frames.length; t++) {
          if (t === reference) continue;
          let sum = 0;
          for (let y = rect.y0; y <= rect.y1; y++) {
            const row = y * width;
            for (let x = rect.x0; x <= rect.x1; x++) sum += frames[t][row + x];
          }
          const meanT = sum / count;
          drop = Math.max(drop, mean0 - meanT);

          // 🔴 **平均を引いてから比べる。** 露出の変動はタイル全体を一様に上下させるだけなので、
          //    引かないと「コントラストの低いタイルほどよく動く」という逆の順位になる。
          let dev = 0;
          for (let y = rect.y0; y <= rect.y1; y++) {
            const row = y * width;
            for (let x = rect.x0; x <= rect.x1; x++) {
              dev += Math.abs((frames[t][row + x] - meanT) - (frames[reference][row + x] - mean0));
            }
          }
          activity += dev / count;
          activityFrames++;
        }
        const contrastChange = sd0 > 1e-9 ? Math.max(0, drop) / sd0 : 0;
        // sd で割ってスケールから自由にする（明るい骨のタイルが自動で勝たないように）。
        const motionHint = activityFrames > 0 && sd0 > 1e-9 ? activity / activityFrames / sd0 : 0;

        const tensor = structureTensorFromGradients(gx, gy, width, height, rect);

        // 🔴 **`anisotropy` は掛け算ではなく門にする。**
        //    アパーチャ問題は λ2/λ1 の下限で落とせる。掛け算にすると「動いているが縁が
        //    一方向」＝心臓の辺縁やカテーテルを軒並み沈め、静止した等方的な骨だけが残る
        //    （実機で採用された 192,352 は anisotropy 0.46・振幅 0.49px の静止タイルだった）。
        if (tensor.lambda1 <= 1e-20 || tensor.anisotropy < minAnisotropy) continue;

        // 🔴 **粗採点は「動いているか」で並べる。勾配の強さで並べてはいけない。**
        //    実機（Rubo Run1）で、心拍を運んでいるタイル (96,144) の λ1 は 6.2e-4、
        //    静止した骨のタイル (192,72) は 3.1e-3 と **5 倍**あった。√λ1 で並べると
        //    前者は上位 24 に入れず、**追尾まで到達しない**。追尾後の点は 10 倍違うのに、
        //    その前に落ちていた。ここで見たいのは「追える構造があるか」＝門であって、
        //    順位ではない。順位は動きで付ける。
        const score = motionHint / (1 + contrastChange);
        coarse.push({ rect, tileSize, tensor, contrastChange, coarse: score });
      }
    }
  }

  coarse.sort((a, b) => (b.coarse - a.coarse) || (a.rect.y0 - b.rect.y0) || (a.rect.x0 - b.rect.x0));

  const out: RoiCandidate[] = [];
  for (const c of coarse.slice(0, shortlist)) {
    const tr = trackPrepared(prepared, c.rect, {
      searchRadius: Math.max(8, Math.floor(c.tileSize / 2)),
      ...opts.track,
    });
    const good = tr.frames.filter((f) => f.reliable);
    const trackScore = good.length ? good.reduce((a, f) => a + f.score, 0) / good.length : 0;

    // 🔴 広がりは**主方向へ射影した**中央値からの距離の p75（RMS ではない）。
    //    1 枚の追尾ミスでも、帯に沿った滑りでも跳ねない。
    const theta = c.tensor.orientationRad;
    let motionPx = trajectorySpread(tr.frames, 0.75, [Math.cos(theta), Math.sin(theta)]);

    // 🚨 **呼吸と拍動を分ける。** 時刻が分かるなら、デトレンド済みの運動信号で測り直し、
    //    周期が生理的な範囲に入っていることを条件にする。横隔膜は呼吸で大きく動くが
    //    心拍帯には現れないので、ここで沈む。
    let periodFrames: number | null = null;
    let bpm: number | null = null;
    if (times) {
      const signal = motionSignal(tr, times);
      motionPx = amplitudeSpan(signal.s) / 2; // p10–p90 の半分＝片振幅。p75 と桁を揃える

      // 🚨 **短い窓で周期を出してはいけない。** 自己相関で周期を決めるには 3 周期ぶんは要る。
      //    実機（Rubo Run1）の造影前は **24 フレーム＝0.96 秒＝1.4 拍**しかなく、ここで
      //    周期を出させると **124〜184 bpm**（真値 90）というでたらめな値が返り、
      //    それで ROI の順位を付けていた。同じタイルを全 137 フレームで測れば 88〜90 bpm と
      //    正しく出る。**心拍かどうかの判定は、窓が足りる場所（対応付けの段）で行う。**
      const spanMs = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
      if (spanMs >= 3 * MAX_PERIOD_MS) {
        const period = estimatePeriod(signal.s, times);
        if (period.confidence !== "none" && period.periodMs > 0) {
          periodFrames = period.periodFrames;
          bpm = 60000 / period.periodMs;
        } else {
          motionPx = 0; // 窓が足りているのに周期が出ない＝心拍ではない
        }
      }
    }

    // 動きの項は頭打ちにする。タイルの 1/4 を超える「動き」は追尾の外れのほうが多い。
    const motionScore = Math.min(motionPx, c.tileSize / 4);

    // 🔴 `tr.reliable === false` でも候補から消さない。実機で、振幅 29.4px・89bpm を
    //    運んでいるタイルは 82/137 フレームしか追えていなかった。**追えた割合を点に掛ける**
    //    ことで、半分しか追えないものを下げつつ完全には捨てない。
    const trackedFraction = tr.frames.length ? good.length / tr.frames.length : 0;
    const aperture = tr.reason === "aperture" || tr.reason === "noTexture";

    // 🔑 `anisotropy` は**順位付けでは掛ける**（縞だけの領域を 1 位にしないための門は
    //    ここが担っている）。実機の不具合は**粗採点の側**で anisotropy を掛けていたことと
    //    shortlist が 8 しかなかったことが原因で、順位付けの側ではない——動きの差が
    //    88 倍あるので、等方性の 2 倍の差では逆転しない。
    out.push({
      rect: c.rect,
      score: aperture ? 0 : c.tensor.anisotropy * trackScore * motionScore * trackedFraction,
      anisotropy: c.tensor.anisotropy,
      lambda1: c.tensor.lambda1,
      contrastChange: c.contrastChange,
      motionPx,
      periodFrames,
      bpm,
      tileSize: c.tileSize,
      trackedFrames: good.length,
      totalFrames: tr.frames.length,
      trackScore,
    });
  }
  out.sort((a, b) => (b.score - a.score) || (a.rect.y0 - b.rect.y0) || (a.rect.x0 - b.rect.x0));
  return out.slice(0, maxCandidates);
}
