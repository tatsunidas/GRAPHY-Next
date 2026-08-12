/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * レジストレーションの類似度指標（設計: `fw/registration-design.md` §5.2）。
 *
 * <p>`regTransform.ts` / `regGeometry.ts` と同じく**純関数のみ**。DOM も cornerstone も
 * import しない。
 *
 * <h3>指標の使い分け</h3>
 * <ul>
 *   <li><b>Mattes 相互情報量 (MI)</b> — PET-CT / PET-MR のようにモダリティが違う組。
 *       強度の対応関係が単調ですらない場合でも成立する。</li>
 *   <li><b>NCC</b> — CT-CT / PET-PET のような同一モダリティ。MI より滑らかで速い。</li>
 * </ul>
 *
 * <h3>決定性 ★</h3>
 *
 * <p>縮約（ヒストグラム加算・総和）は**必ず入力配列のインデックス順**で行う。
 * 完了順やブロック分割の順で足すと実行ごとに丸めが変わり、非凸最適化では
 * それが別の極小への収束になりうる（設計 §6）。この方針は Worker 分割時も同じで、
 * 部分和はインデックス順に統合する。
 */

/**
 * 1 対のサンプル値。`fixed[i]` と `moving[i]` が対応する点。
 *
 * <p>局所指標（LNCC）のときは **1 標本点あたり `patchSize` 個**の値が
 * 連続して並ぶ（`[点0のパッチ..., 点1のパッチ...]`）。`count` は**値の総数**であり、
 * 標本点の数は `count / patchSize`。
 */
export interface SamplePair {
  readonly fixed: Float64Array;
  readonly moving: Float64Array;
  /** 有効な**値**の数（配列の先頭から `count` 個だけを使う）。 */
  readonly count: number;
  /** 1 標本点あたりの値の数。大域指標では 1。 */
  readonly patchSize?: number;
}

/**
 * 正規化相互相関（NCC）。範囲は [−1, 1]、**大きいほど良い**。
 *
 * <p>有効サンプルが 2 未満、またはどちらかの分散が 0 のときは 0 を返す
 * （「相関が無い」＝最悪ではなく無情報。ここで −1 を返すと、視野から外れた解が
 * 「最悪」として強く忌避され、逆に外れかけた位置で最適化が止まる）。
 */
export function ncc(pairs: SamplePair): number {
  const { fixed, moving, count } = pairs;
  if (count < 2) return 0;

  let sumF = 0, sumM = 0;
  for (let n = 0; n < count; n++) { sumF += fixed[n]; sumM += moving[n]; }
  const meanF = sumF / count;
  const meanM = sumM / count;

  let num = 0, varF = 0, varM = 0;
  for (let n = 0; n < count; n++) {
    const df = fixed[n] - meanF;
    const dm = moving[n] - meanM;
    num += df * dm;
    varF += df * df;
    varM += dm * dm;
  }
  const den = Math.sqrt(varF * varM);
  return den > 1e-12 ? num / den : 0;
}

/** MI の設定。 */
export interface MattesOptions {
  /** ヒストグラムのビン数（設計 §5.2 の 32〜64）。 */
  readonly bins?: number;
  /** 強度の下限・上限。省略時はサンプルから決める。 */
  readonly fixedRange?: readonly [number, number];
  readonly movingRange?: readonly [number, number];
}

const DEFAULT_BINS = 48;
/** Parzen 窓（3 次 B-spline）の広がり。B-spline の台は [−2, 2]。 */
const PARZEN_RADIUS = 2;

/** 3 次 B-spline カーネル（台 |u| < 2、総和 1）。 */
function bspline3(u: number): number {
  const a = Math.abs(u);
  if (a < 1) return (4 - 6 * a * a + 3 * a * a * a) / 6;
  if (a < 2) { const t = 2 - a; return (t * t * t) / 6; }
  return 0;
}

function rangeOf(arr: Float64Array, count: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let n = 0; n < count; n++) {
    const v = arr[n];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) { hi = lo + 1; }
  return [lo, hi];
}

/**
 * Mattes 相互情報量。**大きいほど良い**（値は nat）。
 *
 * <p>Mattes らの定式化に従い、同時ヒストグラムを **3 次 B-spline の Parzen 窓**で
 * 積む。単純な最近傍ビンだと MI がパラメータに対して階段状になり、
 * 勾配が 0 か発散のどちらかになって最適化が動かない。窓で滑らかにするのが要点。
 *
 * <p>moving 側だけでなく fixed 側にも窓を掛けている。片側だけにする実装もあるが、
 * ここでは両側に掛けて対称にしてある（fixed の量子化に由来する偏りを避けるため）。
 */
export function mattesMI(pairs: SamplePair, opts: MattesOptions = {}): number {
  return mattesJoint(pairs, opts, false);
}

/**
 * 正規化相互情報量（NMI）。**大きいほど良い**（値は 1 以上）。
 *
 * <p>`NMI = (H(F) + H(M)) / H(F,M)`（Studholme らの定義）。
 *
 * <p>MI は「重なっている領域の情報量」なので、**視野の重なりが変わると値そのものが動く**。
 * 全身のように、少し動かすだけで重なる体積が大きく変わる場面では、
 * 「よく合っている」と「たくさん重なっている」を取り違えることがある。
 * NMI は同時エントロピーで割ることでその依存を弱める。
 *
 * <p>実装は MI と同じ Parzen 窓つき同時ヒストグラムを共有する。
 */
export function normalizedMI(pairs: SamplePair, opts: MattesOptions = {}): number {
  return mattesJoint(pairs, opts, true);
}

function mattesJoint(pairs: SamplePair, opts: MattesOptions, normalized: boolean): number {
  const { fixed, moving, count } = pairs;
  const bins = Math.max(8, Math.floor(opts.bins ?? DEFAULT_BINS));
  if (count < 2) return 0;

  const [fLo, fHi] = opts.fixedRange ?? rangeOf(fixed, count);
  const [mLo, mHi] = opts.movingRange ?? rangeOf(moving, count);
  // 窓の台の分だけ内側に寄せる（端のビンでも窓が収まるように）。
  const usable = bins - 2 * PARZEN_RADIUS;
  if (usable < 2) return 0;
  const fScale = usable / (fHi - fLo);
  const mScale = usable / (mHi - mLo);

  const joint = new Float64Array(bins * bins);
  const margF = new Float64Array(bins);
  const margM = new Float64Array(bins);
  let total = 0;

  for (let n = 0; n < count; n++) {
    // ビン座標（連続値）。PARZEN_RADIUS 分オフセットして端の窓を収める。
    const fp = (fixed[n] - fLo) * fScale + PARZEN_RADIUS;
    const mp = (moving[n] - mLo) * mScale + PARZEN_RADIUS;
    const f0 = Math.floor(fp);
    const m0 = Math.floor(mp);

    for (let df = -PARZEN_RADIUS + 1; df <= PARZEN_RADIUS; df++) {
      const fb = f0 + df;
      if (fb < 0 || fb >= bins) continue;
      const wf = bspline3(fp - fb);
      if (wf <= 0) continue;
      for (let dm = -PARZEN_RADIUS + 1; dm <= PARZEN_RADIUS; dm++) {
        const mb = m0 + dm;
        if (mb < 0 || mb >= bins) continue;
        const w = wf * bspline3(mp - mb);
        if (w <= 0) continue;
        joint[fb * bins + mb] += w;
        total += w;
      }
    }
  }
  if (total <= 0) return 0;

  for (let fb = 0; fb < bins; fb++) {
    let rowSum = 0;
    const base = fb * bins;
    for (let mb = 0; mb < bins; mb++) {
      const p = joint[base + mb] / total;
      joint[base + mb] = p;
      rowSum += p;
      margM[mb] += p;
    }
    margF[fb] = rowSum;
  }

  let mi = 0;
  let hJoint = 0;
  for (let fb = 0; fb < bins; fb++) {
    const pf = margF[fb];
    if (pf <= 0) continue;
    const base = fb * bins;
    for (let mb = 0; mb < bins; mb++) {
      const pj = joint[base + mb];
      if (pj <= 0) continue;
      hJoint -= pj * Math.log(pj);
      const pm = margM[mb];
      if (pm <= 0) continue;
      mi += pj * Math.log(pj / (pf * pm));
    }
  }
  if (!normalized) return mi;

  // NMI = (H(F) + H(M)) / H(F,M)。周辺エントロピーは MI と同時エントロピーから
  // 復元できる（H(F)+H(M) = MI + H(F,M)）ので、ここで足し直す必要はない。
  if (!(hJoint > 1e-12)) return 0;
  return (mi + hJoint) / hJoint;
}

/**
 * 局所正規化相互相関（LNCC）。範囲は [−1, 1]、**大きいほど良い**。
 *
 * <p>大域 NCC は「**画像全体で強度関係が単一の線形式**」という強い仮定を置く。
 * MR のバイアス場、造影の有無、PET の集積差ではこれが崩れ、体の一部が
 * 合っていれば残りがずれていても高い値が出てしまう。LNCC は仮定を
 * **各パッチの中だけ**に弱めるので、その種の破綻に強い。
 * ANTs が同一モダリティの既定に使う `CC` も窓つきの局所相関である。
 *
 * <p>分散がほぼ 0 のパッチ（空気・一様な組織）は**寄与させない**。
 * そこは相関が定義できず、含めると値が標本の取り方で揺れる。
 * 有効パッチが 1 つも無ければ 0（無情報）を返す。
 */
export function localNcc(pairs: SamplePair): number {
  const { fixed, moving, count } = pairs;
  const patch = Math.max(1, Math.floor(pairs.patchSize ?? 1));
  if (patch < 2) return ncc(pairs); // パッチが無ければ大域と同じ
  const nPatches = Math.floor(count / patch);
  if (nPatches < 1) return 0;

  let sum = 0;
  let used = 0;
  for (let p = 0; p < nPatches; p++) {
    const base = p * patch;
    let sf = 0, sm = 0;
    for (let i = 0; i < patch; i++) { sf += fixed[base + i]; sm += moving[base + i]; }
    const mf = sf / patch, mm = sm / patch;
    let num = 0, vf = 0, vm = 0;
    for (let i = 0; i < patch; i++) {
      const df = fixed[base + i] - mf;
      const dm = moving[base + i] - mm;
      num += df * dm; vf += df * df; vm += dm * dm;
    }
    const den = Math.sqrt(vf * vm);
    if (!(den > 1e-9)) continue;
    sum += num / den;
    used++;
  }
  return used > 0 ? sum / used : 0;
}

/** 指標の種類。`auto` は呼び出し側がモダリティから決める。 */
/**
 * 指標の種類。
 *
 * <p><b>MIND-SSC は剛体の指標として入れていない</b>（一度実装して測ったうえで外した）。
 * 記述子は 12 ペアを**格子軸方向**に定義するため方向依存で、moving の記述子を
 * 回転前の格子で作って回転後の位置を引くと、**回転が大きいほど正しい答えが不利**になる。
 * 合成ファントムでの実測: 並進のみなら NCC と同等（0.04mm）だが、回転 3°/8°/15° に対して
 * 誤差 1.69°/4.00°/7.40°（真値の約半分しか戻せない）。
 * 直すには moving の記述子を**現在の変換を通して作り直す**必要があり（非剛体側は
 * そうしている）、外側の反復を足す構造変更になる。PET-MR で MI が実際に困っている
 * という測定が出てから着手する。
 */
export type MetricKind = "mi" | "nmi" | "ncc" | "lncc";

/**
 * 指標を名前で評価する。**いずれも「大きいほど良い」**に揃えてある。

 */
export function evaluateMetric(kind: MetricKind, pairs: SamplePair, opts?: MattesOptions): number {
  if (kind === "ncc") return ncc(pairs);
  if (kind === "lncc") return localNcc(pairs);
  if (kind === "nmi") return normalizedMI(pairs, opts);
  return mattesMI(pairs, opts);
}
