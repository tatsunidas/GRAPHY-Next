/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2 次元フーリエ解析（2D Viewer > 解析 > フーリエ解析）の純関数群（fw/fourier-design.md）。
 *
 * - 入力は表示中スライス 1 枚。2 のべき乗の正方形へ**平均値で**パディング（元画像は左上＝ImageJ と同じ）してから FFT する。
 * - スペクトルの座標は 2 系統ある。**非シフト**（DC が index 0、FFT の生の並び）と
 *   **シフト後**（`fftshift` 済み、DC が (n/2, n/2)）。マスクと基底座標は**シフト後**で持つ。
 *   n は偶数なので、シフト後 index `i` の周波数は `i - n/2`、非シフト index は `(i + n/2) % n`。
 * - 正規化は「順変換は係数そのまま、逆変換で 1/N² を掛ける」。よって
 *   `Σ_{u,v} Re(F(u,v)·e^{i2π(ux+vy)/N}) / N² = 元画像`（`basisImage` の重み付きの和）。
 *
 * DOM / WebWorker 固有のグローバルを使わないので、アプリ・Worker・vitest から共通に使える。
 */

/** 扱う最大の一辺（パディング後）。4096² を超えるとメモリを GB 単位で使うので断る。 */
export const MAX_FFT_SIZE = 4096;

/** RGB を 8bit グレースケールへ（輝度化は `readModalitySlice` 済みなので丸めと 0〜255 への収めのみ）。 */
export function toGray8(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(values[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Number.isFinite(v) ? v : 0;
  }
  return out;
}

export function nextPow2(v: number): number {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}

export interface Padded {
  /** n×n、row-major。 */
  data: Float64Array;
  n: number;
  /** 元画像の左上が置かれた位置。 */
  offX: number;
  offY: number;
  width: number;
  height: number;
  mean: number;
}

/**
 * 2 のべき乗の正方形へ平均値でパディングし、元画像を**左上**に置く。
 * ImageJ の Process > FFT と同じ置き方（平均値で埋め、原点に置く）なので、係数が ImageJ の
 * 「Complex Fourier Transform」と一致し、書き出した Re・Im を ImageJ の Inverse FFT で戻せる。
 */
export function padToPow2Square(values: ArrayLike<number>, width: number, height: number): Padded {
  const n = Math.max(2, nextPow2(Math.max(width, height)));
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < width * height; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      cnt++;
    }
  }
  const mean = cnt ? sum / cnt : 0;
  const data = new Float64Array(n * n).fill(mean);
  const offX = 0;
  const offY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = values[y * width + x];
      data[(y + offY) * n + x + offX] = Number.isFinite(v) ? v : mean;
    }
  }
  return { data, n, offX, offY, width, height, mean };
}

/** パディング済み n×n から元の大きさを切り出す。 */
export function cropFromPadded(
  data: ArrayLike<number>,
  n: number,
  offX: number,
  offY: number,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (y + offY) * n + offX;
    for (let x = 0; x < width; x++) out[y * width + x] = data[row + x];
  }
  return out;
}

// ── FFT ─────────────────────────────────────────────────────────

interface FftTables {
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}
const tableCache = new Map<number, FftTables>();

function tables(n: number): FftTables {
  let t = tableCache.get(n);
  if (t) return t;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  tableCache.set(n, t);
  return t;
}

/** 1 次元 FFT（in-place、反復型 radix-2、正規化なし）。`inverse` は e^{+i} 側の核（1/n は掛けない）。 */
export function fft1d(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  if (n & (n - 1)) throw new Error(`FFT size must be a power of 2: ${n}`);
  const { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < halfSize; k++) {
        const c = cos[k * step];
        const s = sign * sin[k * step];
        const a = start + k;
        const b = a + halfSize;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** 2 次元 FFT（in-place、行→列）。逆変換は 1/n² を掛ける。 */
export function fft2d(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  const bRe = new Float64Array(n);
  const bIm = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const o = y * n;
    for (let x = 0; x < n; x++) {
      bRe[x] = re[o + x];
      bIm[x] = im[o + x];
    }
    fft1d(bRe, bIm, inverse);
    for (let x = 0; x < n; x++) {
      re[o + x] = bRe[x];
      im[o + x] = bIm[x];
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      bRe[y] = re[y * n + x];
      bIm[y] = im[y * n + x];
    }
    fft1d(bRe, bIm, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = bRe[y];
      im[y * n + x] = bIm[y];
    }
  }
  if (inverse) {
    const k = 1 / (n * n);
    for (let i = 0; i < n * n; i++) {
      re[i] *= k;
      im[i] *= k;
    }
  }
}

/** 四象限の入れ替え（n 偶数なので自己逆）。新しい配列を返す。 */
export function fftshift<T extends Float32Array | Float64Array>(src: T, n: number): T {
  const out = new (src.constructor as { new (len: number): T })(src.length);
  const h = n >> 1;
  for (let y = 0; y < n; y++) {
    const sy = (y + h) % n;
    for (let x = 0; x < n; x++) out[sy * n + ((x + h) % n)] = src[y * n + x];
  }
  return out;
}

/** 表示用 log(1+|x|)。 */
export function logScale(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.log1p(Math.abs(values[i]));
  return out;
}

// ── 周波数フィルタ ───────────────────────────────────────────────

export type FilterMode = "pass" | "stop";

export type FilterSpec =
  | { kind: "none" }
  /** 内側を除去する帯。縦＝全高で x 方向の位置 `center`（DC 基準）、横＝全幅で y 方向。 */
  | { kind: "rect"; orientation: "vertical" | "horizontal"; center: number; width: number; mirror: boolean }
  /** DC 中心の円。pass(∧)＝内側を残す／stop(!∧)＝内側を除去。 */
  | { kind: "circle"; radius: number; mode: FilterMode }
  /** DC 中心のドーナツ（半径 `radius` を中心に幅 `width`）。 */
  | { kind: "donut"; radius: number; width: number; mode: FilterMode };

/** 標準正規分布の累積分布関数（Abramowitz–Stegun 7.1.26 の erf 近似、誤差 < 1.5e-7）。 */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** 縁までの符号付き距離 d（外側が正）から「内側らしさ」0〜1。σ=0 なら階段。 */
function insideWeight(d: number, sigma: number): number {
  if (!(sigma > 0)) return d <= 0 ? 1 : 0;
  return normalCdf(-d / sigma);
}

/**
 * シフト後座標（DC=(n/2,n/2)）の通過マスク 0〜1 を作る。
 * `sigma` は縁のガウシアンのなだらかさ（px）。
 */
export function buildMask(spec: FilterSpec, n: number, sigma: number): Float32Array {
  const mask = new Float32Array(n * n);
  const h = n >> 1;
  if (spec.kind === "none") return mask.fill(1);
  for (let y = 0; y < n; y++) {
    const fy = y - h;
    for (let x = 0; x < n; x++) {
      const fx = x - h;
      let w: number;
      if (spec.kind === "rect") {
        const p = spec.orientation === "vertical" ? fx : fy;
        const half = spec.width / 2;
        let inside = insideWeight(Math.abs(p - spec.center) - half, sigma);
        if (spec.mirror && spec.center !== 0) {
          const other = insideWeight(Math.abs(p + spec.center) - half, sigma);
          inside = 1 - (1 - inside) * (1 - other);
        }
        w = 1 - inside;
      } else {
        const r = Math.hypot(fx, fy);
        const d = spec.kind === "circle" ? r - spec.radius : Math.abs(r - spec.radius) - spec.width / 2;
        const inside = insideWeight(d, sigma);
        w = spec.mode === "pass" ? inside : 1 - inside;
      }
      mask[y * n + x] = w;
    }
  }
  return mask;
}

/**
 * 長方形の帯の位置（DC 基準）の上限 |center|。帯（|p − center| ≤ width/2）とその枠が
 * スペクトルの外（index 0〜n−1）へはみ出さない範囲。ミラーの帯も同じ範囲に収まるよう対称にする。
 */
export function rectCenterLimit(n: number, width: number): number {
  return Math.max(0, Math.floor(n / 2 - 0.5 - width / 2));
}

/** マスクが 1 未満の値を 1 つでも含むか（＝フィルタが実際に効いているか）。 */
export function isMaskActive(mask: ArrayLike<number>): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] < 1) return true;
  return false;
}

/**
 * 同じ座標系（ともにシフト後）の値とマスクの積。マスクは 0〜1 なので |Re·m| = |Re|·m となり、
 * 絶対値の表示・書き出しにもそのまま使える。
 */
export function multiplyMask(values: Float32Array, mask: ArrayLike<number>): Float32Array {
  if (values.length !== mask.length) throw new Error("values.length !== mask.length");
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] * mask[i];
  return out;
}

/**
 * 書き出し用の符号付き [Re, Im]（ともに n×n）。入力はシフト後の符号付き実部・虚部。
 * `mask`（シフト後、0〜1）があれば掛け、`shifted=false` なら FFT の生の並び（DC が index 0）へ戻す。
 * 正規化は順変換のまま（係数そのもの）なので、`numpy.fft.ifft2(Re + 1j·Im)`（shifted なら先に ifftshift）で
 * パディング後の画像に戻る。
 */
export function complexExportSlices(
  realShifted: Float32Array,
  imagShifted: Float32Array,
  n: number,
  mask: ArrayLike<number> | null,
  shifted: boolean,
): [Float32Array, Float32Array] {
  let re = mask ? multiplyMask(realShifted, mask) : realShifted.slice();
  let im = mask ? multiplyMask(imagShifted, mask) : imagShifted.slice();
  if (!shifted) {
    re = fftshift(re, n);
    im = fftshift(im, n);
  }
  return [re, im];
}

/** Re・Im スタックに添える説明（ImageJ の Show Info に出る。英語で固定＝ファイルは言語設定に依らない）。 */
export function complexStackInfo(p: {
  seriesLabel: string;
  sliceIndex: number;
  n: number;
  width: number;
  height: number;
  filtered: boolean;
}): string {
  return [
    "GRAPHY-Next Fourier analysis: signed 2D DFT coefficients (ImageJ Complex Fourier Transform format)",
    `source: ${p.seriesLabel} slice ${p.sliceIndex + 1} (${p.width}x${p.height})`,
    "slice 1 = Real, slice 2 = Imaginary (signed)",
    `size: ${p.n}x${p.n}; source placed at top-left and padded with its mean (same as ImageJ)`,
    "transform: forward DFT, unnormalized, kernel exp(-i*2*pi*(u*x+v*y)/N)",
    "layout: quadrant-swapped (DC at N/2, N/2)",
    `filter applied: ${p.filtered ? "yes (coefficients multiplied by the mask)" : "no"}`,
    "",
    "Inverse in ImageJ: Process > FFT > Inverse FFT (crops back to the original size)",
    "Inverse in numpy:",
    "  F = numpy.fft.ifftshift(Re + 1j*Im)",
    "  img = numpy.fft.ifft2(F).real   # ifft2 divides by N^2",
    `  img = img[0:${p.height}, 0:${p.width}]`,
  ].join("\n");
}

/** ImageJ の Inverse FFT が元の大きさへ切り戻すのに使うプロパティ（ImageJ 自身の書き出しと同じキー）。 */
export function imageJComplexProperties(width: number, height: number): [string, string][] {
  return [
    [" ", "Complex Fourier Transform"],
    ["Original height", String(height)],
    ["Original width", String(width)],
  ];
}

/** 非シフトのスペクトルにシフト後座標のマスクを掛けた複製を返す。 */
export function applyMask(
  re: Float64Array,
  im: Float64Array,
  n: number,
  shiftedMask: Float32Array,
): { re: Float64Array; im: Float64Array } {
  const oRe = new Float64Array(n * n);
  const oIm = new Float64Array(n * n);
  const h = n >> 1;
  for (let y = 0; y < n; y++) {
    const my = (y + h) % n;
    for (let x = 0; x < n; x++) {
      const k = y * n + x;
      const m = shiftedMask[my * n + ((x + h) % n)];
      oRe[k] = re[k] * m;
      oIm[k] = im[k] * m;
    }
  }
  return { re: oRe, im: oIm };
}

// ── 基底関数 ─────────────────────────────────────────────────────

/**
 * シフト後座標 (u, v) の基底（n×n）。周波数は (u-n/2, v-n/2)。
 * `coeff` 無し＝純粋な基底 cos(2π(fx·x+fy·y)/n)。
 * `coeff` あり＝その成分の実寄与 Re(F·e^{i2π(fx·x+fy·y)/n}) / n²（全 (u,v) の和が元画像）。
 */
export function basisImage(u: number, v: number, n: number, coeff?: { re: number; im: number }): Float32Array {
  const h = n >> 1;
  const fx = u - h;
  const fy = v - h;
  const out = new Float32Array(n * n);
  const amp = coeff ? Math.hypot(coeff.re, coeff.im) / (n * n) : 1;
  const phase = coeff ? Math.atan2(coeff.im, coeff.re) : 0;
  const k = (2 * Math.PI) / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) out[y * n + x] = amp * Math.cos(k * (fx * x + fy * y) + phase);
  }
  return out;
}

/** シフト後 (u,v) → 非シフト index。 */
export function unshiftedIndex(u: number, v: number, n: number): number {
  const h = n >> 1;
  return ((v + h) % n) * n + ((u + h) % n);
}

// ── 動径平均スペクトル（ナイキスト周波数つきグラフ）─────────────────

export interface RadialProfile {
  /** ビンの中心周波数（`unit`）。 */
  freq: Float64Array;
  /** ビンごとの |F| の平均（フィルタなし）。 */
  mean: Float64Array;
  /** マスクを渡したときだけ: |F|·m の平均。 */
  meanMasked: Float64Array | null;
  /** 列方向（x）・行方向（y）のナイキスト周波数（`unit`）。 */
  nyquistX: number;
  nyquistY: number;
  /** PixelSpacing があれば "lp/mm"、無ければ "cycles/px"。 */
  unit: "lp/mm" | "cycles/px";
}

/**
 * シフト後の |F|（n×n）を DC からの距離（物理的な空間周波数）ごとに平均する。
 * 周波数は fx = (u−n/2)/(n·dx)、fy = (v−n/2)/(n·dy)、f = hypot(fx, fy)。
 * `dx`・`dy`（mm/px）のどちらかが無ければ 1 として cycles/px で返す（ナイキストは 0.5）。
 */
export function radialProfile(
  magnitudeShifted: ArrayLike<number>,
  n: number,
  dx: number | null | undefined,
  dy: number | null | undefined,
  mask?: ArrayLike<number> | null,
): RadialProfile {
  const physical = !!(dx && dx > 0 && dy && dy > 0);
  const sx = physical ? (dx as number) : 1;
  const sy = physical ? (dy as number) : 1;
  const h = n >> 1;
  const stepX = 1 / (n * sx);
  const stepY = 1 / (n * sy);
  const bin = Math.min(stepX, stepY);
  const maxF = Math.hypot(h * stepX, h * stepY);
  const bins = Math.floor(maxF / bin + 0.5) + 1;
  const sum = new Float64Array(bins);
  const sumM = mask ? new Float64Array(bins) : null;
  const cnt = new Float64Array(bins);
  for (let v = 0; v < n; v++) {
    const fy = (v - h) * stepY;
    for (let u = 0; u < n; u++) {
      const k = Math.floor(Math.hypot((u - h) * stepX, fy) / bin + 0.5);
      const i = v * n + u;
      sum[k] += magnitudeShifted[i];
      if (sumM && mask) sumM[k] += magnitudeShifted[i] * mask[i];
      cnt[k]++;
    }
  }
  // 中身の無いビン（異方性の格子で飛ぶ距離）は詰める。
  const keep: number[] = [];
  for (let k = 0; k < bins; k++) if (cnt[k] > 0) keep.push(k);
  const freq = new Float64Array(keep.length);
  const mean = new Float64Array(keep.length);
  const meanMasked = sumM ? new Float64Array(keep.length) : null;
  keep.forEach((k, j) => {
    freq[j] = k * bin;
    mean[j] = sum[k] / cnt[k];
    if (meanMasked && sumM) meanMasked[j] = sumM[k] / cnt[k];
  });
  return { freq, mean, meanMasked, nyquistX: 1 / (2 * sx), nyquistY: 1 / (2 * sy), unit: physical ? "lp/mm" : "cycles/px" };
}

// ── 1D ラインの波形分解（3D ウォーターフォール）────────────────────

export interface WaveComponent {
  /** 1 ライン長 L あたりの周期数（0〜⌊L/2⌋）。周波数は k/L cycles/px。 */
  k: number;
  /** 振幅（その成分の cos の係数。DC は平均値の絶対値）。 */
  amp: number;
  /** 位相 rad。 */
  phase: number;
}

/**
 * 長さ L のプロファイルを正弦波成分へ分解する（パディングなしの 1D DFT を直接計算）。
 * `Σ_k amp·cos(2πk·x/L + phase) = values[x]` が成り立つよう、DC とナイキスト（L 偶数の k=L/2）は
 * |X|/L、それ以外は 2|X|/L で正規化する。
 */
export function decomposeLine(values: ArrayLike<number>): WaveComponent[] {
  const L = values.length;
  const out: WaveComponent[] = [];
  for (let k = 0; k <= L >> 1; k++) {
    let re = 0;
    let im = 0;
    const w = (-2 * Math.PI * k) / L;
    for (let x = 0; x < L; x++) {
      const v = Number.isFinite(values[x]) ? values[x] : 0;
      re += v * Math.cos(w * x);
      im += v * Math.sin(w * x);
    }
    const single = k === 0 || 2 * k === L;
    out.push({ k, amp: (Math.hypot(re, im) * (single ? 1 : 2)) / L, phase: Math.atan2(im, re) });
  }
  return out;
}

/** 成分 1 つの波形（長さ L）。 */
export function waveOf(c: WaveComponent, L: number): Float32Array {
  const out = new Float32Array(L);
  const w = (2 * Math.PI * c.k) / L;
  for (let x = 0; x < L; x++) out[x] = c.amp * Math.cos(w * x + c.phase);
  return out;
}

/** DC を除き振幅の大きい順に K 個（同振幅は低周波を先に）。返り値は周波数の昇順。 */
export function topComponents(components: WaveComponent[], K: number): WaveComponent[] {
  return components
    .filter((c) => c.k > 0)
    .sort((a, b) => b.amp - a.amp || a.k - b.k)
    .slice(0, Math.max(0, K))
    .sort((a, b) => a.k - b.k);
}

/**
 * 3D 点 [x, y(上), z(奥)] を正射影する。yaw＝鉛直軸まわり、pitch＝水平軸まわり（rad）。
 * 返り値の `depth` が大きいほど奥（描くときは depth の大きい順＝奥から手前へ）。
 */
export function project3d(
  p: readonly [number, number, number],
  yaw: number,
  pitch: number,
  scale: number,
  cx: number,
  cy: number,
): { x: number; y: number; depth: number } {
  const [x, y, z] = p;
  const cyw = Math.cos(yaw);
  const syw = Math.sin(yaw);
  const x1 = x * cyw + z * syw;
  const z1 = -x * syw + z * cyw;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  return { x: cx + x1 * scale, y: cy - y2 * scale, depth: z2 };
}

/**
 * 系列のうち「両隣が 0（または端）」の点の添字。
 *
 * <p>グラフは点と点を線分で結ぶので、孤立した点は線にならず何も描かれない。合成した縞のような
 * きれいな画像では動径平均が飛び飛びのビンにしか入らず、それが**グラフが空に見える**原因になる。
 * 呼び出し側はここで返った点を点（マーカー）として描く。
 */
export function isolatedIndices(s: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (!(s[i] > 0)) continue;
    if (i > 0 && s[i - 1] > 0) continue;
    if (i + 1 < s.length && s[i + 1] > 0) continue;
    out.push(i);
  }
  return out;
}
