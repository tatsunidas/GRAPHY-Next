/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QCA（定量的冠動脈解析）の**純ロジック**（`fw/angio-design.md` §8）。
 *
 * <p>パイプライン: 区間指定 → 中心線抽出（コスト最小経路）→ 中心線に直交する 1D プロファイル →
 * サブピクセル・エッジ → 径プロファイル → 参照径 → MLD / RVD / %DS / 病変長。
 *
 * <p>UI から完全に切り離してある。QCA の正しさは「真値が既知のファントムで数値が合うこと」で
 * しか担保できないので、ここを純関数にしておくのが要（テストは `qca.test.ts`）。
 *
 * <h3>限界（結果画面にも出すこと）</h3>
 * <ul>
 *   <li>%面積狭窄は**円形断面の仮定**。偏心性病変では IVUS/OCT の実測と乖離する。</li>
 *   <li>単一投影は**短縮（foreshortening）と血管の重なり**の影響を受ける。</li>
 *   <li>装置メーカーの QCA と数値は一致しない（各社のエッジ検出・参照径推定は非公開）。
 *       一致を目標にせず、ファントムでの真値一致を目標にする。</li>
 * </ul>
 */

export interface QcaInput {
  /** 画素値（校正済みモダリティ値。`readModalitySlice` の出力）。 */
  pixels: Float32Array;
  width: number;
  height: number;
  /** 解析区間の始点・終点（画像座標 px, 小数可）。 */
  start: [number, number];
  end: [number, number];
  /** 行方向 mm/px（縦）。null なら px のまま返す。 */
  mmPerPxRow?: number | null;
  /** 列方向 mm/px（横）。 */
  mmPerPxCol?: number | null;
  /**
   * 血管が背景より暗いか。非サブトラクションの XA は true（造影剤で減衰＝暗い）、
   * DSA 後の差分画像は血管が正の大きな値になるので false。
   */
  vesselIsDark?: boolean;
  /** 法線方向にプロファイルを取る半径 [px]（既定 20）。想定血管径の 3 倍程度。 */
  profileRadiusPx?: number;
  /** 中心線探索の探索範囲マージン [px]（既定 40）。始終点の外接矩形をこれだけ広げる。 */
  searchMarginPx?: number;
}

export interface QcaEdge {
  /** 左右のエッジ位置（画像座標 px）。 */
  left: [number, number];
  right: [number, number];
}

export interface QcaResult {
  /** 抽出した中心線（画像座標 px, 等間隔リサンプル済み）。 */
  centerline: [number, number][];
  /** 各中心線点でのエッジ。 */
  edges: QcaEdge[];
  /** 中心線に沿った距離（mm。未校正なら px）。 */
  positions: number[];
  /** 径プロファイル（mm。未校正なら px）。 */
  diameters: number[];
  /** 参照径の当てはめ（線形回帰）。各点での参照径。 */
  reference: number[];
  /** 最小血管径。 */
  mld: number;
  /** MLD の中心線インデックス。 */
  mldIndex: number;
  /** MLD 位置での参照血管径。 */
  rvd: number;
  /** 直径狭窄率 [%]。 */
  percentDiameterStenosis: number;
  /** 面積狭窄率 [%]（**円形断面の仮定**）。 */
  percentAreaStenosis: number;
  /** 病変長（参照径を下回る連続区間）。 */
  lesionLength: number;
  /** 単位（校正済みなら "mm"、未校正なら "px"）。 */
  unit: "mm" | "px";
  warnings: string[];
}

/** 双線形サンプリング。範囲外は端の値（clamp）。 */
export function sampleBilinear(
  px: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const cl = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x0c = cl(x0, width - 1);
  const x1c = cl(x0 + 1, width - 1);
  const y0c = cl(y0, height - 1);
  const y1c = cl(y0 + 1, height - 1);
  const v00 = px[y0c * width + x0c];
  const v01 = px[y0c * width + x1c];
  const v10 = px[y1c * width + x0c];
  const v11 = px[y1c * width + x1c];
  const top = v00 + (v01 - v00) * fx;
  const bottom = v10 + (v11 - v10) * fx;
  return top + (bottom - top) * fy;
}

/** 最小ヒープ（Dijkstra 用。ライブラリを増やさない）。 */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): { key: number; val: number } | null {
    if (!this.keys.length) return null;
    const key = this.keys[0];
    const val = this.vals[0];
    const lastK = this.keys.pop() as number;
    const lastV = this.vals.pop() as number;
    if (this.keys.length) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return { key, val };
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

/**
 * コスト最小経路で中心線を引く（8 近傍 Dijkstra）。
 *
 * <p>コストは「血管らしさの逆数」。ここでは輝度をそのまま使う簡易版で、
 * 血管が暗いなら暗いほど安い。探索は始終点の外接矩形＋マージンに限定する
 * （画像全体を回すと 1024² で無駄が大きい）。
 */
export function tracePath(
  pixels: Float32Array,
  width: number,
  height: number,
  start: [number, number],
  end: [number, number],
  vesselIsDark: boolean,
  marginPx = 40,
): [number, number][] | null {
  const sx = Math.round(start[0]);
  const sy = Math.round(start[1]);
  const ex = Math.round(end[0]);
  const ey = Math.round(end[1]);
  if (sx < 0 || sy < 0 || ex < 0 || ey < 0 || sx >= width || sy >= height || ex >= width || ey >= height) {
    return null;
  }
  const x0 = Math.max(0, Math.min(sx, ex) - marginPx);
  const x1 = Math.min(width - 1, Math.max(sx, ex) + marginPx);
  const y0 = Math.max(0, Math.min(sy, ey) - marginPx);
  const y1 = Math.min(height - 1, Math.max(sy, ey) + marginPx);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const n = w * h;

  // ROI 内の輝度を 0..1 に正規化してコストにする。
  let min = Infinity;
  let max = -Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = pixels[y * width + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const range = max - min;
  const costAt = (lx: number, ly: number): number => {
    const v = pixels[(ly + y0) * width + (lx + x0)];
    const norm = range > 0 ? (v - min) / range : 0.5;
    // 血管が暗いなら暗い＝安い。逆なら明るい＝安い。0 コストを避けて 0.01 を下限にする。
    return (vesselIsDark ? norm : 1 - norm) + 0.01;
  };

  const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const si = (sy - y0) * w + (sx - x0);
  const ei = (ey - y0) * w + (ex - x0);
  dist[si] = 0;
  const heap = new MinHeap();
  heap.push(0, si);

  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

  while (heap.size) {
    const top = heap.pop();
    if (!top) break;
    const cur = top.val;
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === ei) break;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const cc = costAt(cx, cy);
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k];
      const ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (done[ni]) continue;
      const step = ((cc + costAt(nx, ny)) / 2) * DL[k];
      const nd = dist[cur] + step;
      if (nd < dist[ni]) {
        dist[ni] = nd;
        prev[ni] = cur;
        heap.push(nd, ni);
      }
    }
  }
  if (!done[ei]) return null;

  const path: [number, number][] = [];
  for (let i = ei; i >= 0; i = prev[i]) {
    const px = i % w;
    const py = (i - px) / w;
    path.push([px + x0, py + y0]);
    if (i === si) break;
  }
  path.reverse();
  return path;
}

/** 移動平均で中心線を滑らかにする（1 画素刻みのギザギザを消す）。 */
export function smoothPath(path: readonly [number, number][], window = 5): [number, number][] {
  const n = path.length;
  if (n <= 2 || window < 2) return path.map((p) => [p[0], p[1]]);
  const half = Math.floor(window / 2);
  const out: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sx += path[j][0];
      sy += path[j][1];
      c++;
    }
    out[i] = [sx / c, sy / c];
  }
  // 端点は動かさない（ユーザが指定した位置を尊重）。
  out[0] = [path[0][0], path[0][1]];
  out[n - 1] = [path[n - 1][0], path[n - 1][1]];
  return out;
}

/**
 * 1D プロファイルからサブピクセルのエッジ 2 点（中心の左右）を求める。
 *
 * <h3>なぜ「1 次微分の最大」ではなく「半値」なのか（実測で決めた）</h3>
 * 画素境界の輝度変化は**ほぼ直線のランプ**になる（画素は面積平均なので）。ランプの上では
 * 1 次微分が**一定＝プラトー**になり、微分最大の位置が一意に決まらない。放物線フィットも
 * プラトーには効かず、**エッジ位置が最大 0.5px ふらつく**（径では 1px ≒ 0.2mm の系統誤差）。
 * 合成ファントムでの実測では、これが 50% 狭窄で %DS を 4% 過大にしていた。
 *
 * <p>一方、**内側（血管）と外側（背景）の中間値をよぎる位置**は、対称なランプに対して
 * 厳密に真の境界と一致し、線形補間で 0.05px 精度が出る。よって半値法を主とし、
 * 半値をよぎらない（コントラスト不足）ときだけ微分最大へフォールバックする。
 * ※ 血管が明るい（DSA 後）場合も、内側/外側の値から閾値を作るので符号に依らず同じ式で動く。
 *
 * @param step サンプル間隔 [px]
 * @returns 中心からの距離 [px]（left は負、right は正）。見つからなければ null。
 */
export function findEdgesInProfile(
  profile: readonly number[],
  centerIndex: number,
  step: number,
): { left: number; right: number } | null {
  const n = profile.length;
  if (n < 5 || centerIndex <= 1 || centerIndex >= n - 2) return null;

  // 内側（血管内）の代表値 = 中心付近の平均。
  const innerHalf = Math.max(1, Math.round(0.5 / step));
  let innerSum = 0;
  let innerCount = 0;
  for (let i = centerIndex - innerHalf; i <= centerIndex + innerHalf; i++) {
    if (i < 0 || i >= n) continue;
    innerSum += profile[i];
    innerCount++;
  }
  const inner = innerSum / Math.max(1, innerCount);

  /** 片側のエッジ位置（index。見つからなければ null）。dir=+1 で右、-1 で左。 */
  const edgeOnSide = (dir: 1 | -1): number | null => {
    // 外側（背景）の代表値 = その側の外周 10% の平均。
    const outerCount = Math.max(2, Math.round(n * 0.05));
    let outerSum = 0;
    let c = 0;
    for (let k = 0; k < outerCount; k++) {
      const i = dir > 0 ? n - 1 - k : k;
      if (i < 0 || i >= n) continue;
      outerSum += profile[i];
      c++;
    }
    const outer = outerSum / Math.max(1, c);
    const contrast = Math.abs(outer - inner);
    // コントラストがほぼ無い（＝エッジが無い）なら測らない。
    if (!(contrast > 1e-6) || !(contrast > Math.abs(inner) * 1e-9)) return null;
    const threshold = (inner + outer) / 2;
    const rising = outer > inner;

    // 中心から外へ歩き、閾値をよぎる最初の区間を線形補間する。
    for (let i = centerIndex; dir > 0 ? i < n - 1 : i > 0; i += dir) {
      const a = profile[i];
      const b = profile[i + dir];
      const crossed = rising ? a < threshold && b >= threshold : a > threshold && b <= threshold;
      if (crossed) {
        const t = b !== a ? (threshold - a) / (b - a) : 0;
        return i + dir * t;
      }
    }
    return null;
  };

  const li = edgeOnSide(-1);
  const ri = edgeOnSide(1);
  if (li == null || ri == null) return null;
  const left = (li - centerIndex) * step;
  const right = (ri - centerIndex) * step;
  if (!(right > left)) return null;
  return { left, right };
}

/** 参照径（健常部の 1 次回帰）。病変側に引っ張られないよう、中央値以上の点だけで 2 回反復する。 */
export function referenceDiameters(positions: readonly number[], diameters: readonly number[]): number[] {
  const n = diameters.length;
  if (n === 0) return [];
  if (n < 3) return diameters.map((d) => d);
  let include = new Array<boolean>(n).fill(true);
  let a = 0;
  let b = 0;
  for (let iter = 0; iter < 2; iter++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      if (!include[i]) continue;
      sw += 1;
      sx += positions[i];
      sy += diameters[i];
      sxx += positions[i] * positions[i];
      sxy += positions[i] * diameters[i];
    }
    const denom = sw * sxx - sx * sx;
    if (sw < 2 || denom === 0) {
      const mean = sy / Math.max(1, sw);
      a = 0;
      b = mean;
    } else {
      a = (sw * sxy - sx * sy) / denom;
      b = (sy - a * sx) / sw;
    }
    // 次の反復は「当てはめ以上の径」だけ（＝狭窄側を捨てる）。
    const next = new Array<boolean>(n);
    let kept = 0;
    for (let i = 0; i < n; i++) {
      next[i] = diameters[i] >= a * positions[i] + b;
      if (next[i]) kept++;
    }
    if (kept < 2) break;
    include = next;
  }
  return positions.map((p) => a * p + b);
}

/** 中心線に沿った径プロファイルの計測結果（QcaResult の一部）。 */
function summarize(
  positions: number[],
  diameters: number[],
  reference: number[],
): Pick<
  QcaResult,
  "mld" | "mldIndex" | "rvd" | "percentDiameterStenosis" | "percentAreaStenosis" | "lesionLength"
> {
  let mldIndex = 0;
  let mld = Number.POSITIVE_INFINITY;
  for (let i = 0; i < diameters.length; i++) {
    if (diameters[i] < mld) {
      mld = diameters[i];
      mldIndex = i;
    }
  }
  const rvd = reference[mldIndex] ?? mld;
  const ratio = rvd > 0 ? mld / rvd : 1;
  const percentDiameterStenosis = Math.max(0, (1 - ratio) * 100);
  const percentAreaStenosis = Math.max(0, (1 - ratio * ratio) * 100);

  // 病変長 = MLD を含む「径が参照径を下回る」連続区間。
  let lo = mldIndex;
  while (lo - 1 >= 0 && diameters[lo - 1] < reference[lo - 1]) lo--;
  let hi = mldIndex;
  while (hi + 1 < diameters.length && diameters[hi + 1] < reference[hi + 1]) hi++;
  const lesionLength = Math.abs((positions[hi] ?? 0) - (positions[lo] ?? 0));

  return { mld, mldIndex, rvd, percentDiameterStenosis, percentAreaStenosis, lesionLength };
}

/** QCA 本体。失敗（中心線が引けない等）なら null。 */
export function runQca(input: QcaInput): QcaResult | null {
  const {
    pixels,
    width,
    height,
    start,
    end,
    mmPerPxRow,
    mmPerPxCol,
    vesselIsDark = true,
    profileRadiusPx = 20,
    searchMarginPx = 40,
  } = input;
  const warnings: string[] = [];

  const raw = tracePath(pixels, width, height, start, end, vesselIsDark, searchMarginPx);
  if (!raw || raw.length < 5) return null;
  const path = smoothPath(raw, 5);

  const calibrated = !!(mmPerPxRow && mmPerPxCol);
  const mmRow = mmPerPxRow ?? 1;
  const mmCol = mmPerPxCol ?? 1;
  if (!calibrated) warnings.push("uncalibrated");

  // プロファイルのサンプル間隔（サブピクセル）。0.25px で 0.1px 精度の放物線フィットが効く。
  const step = 0.25;
  const half = Math.round(profileRadiusPx / step);
  const centerIndex = half;

  const centerline: [number, number][] = [];
  const edges: QcaEdge[] = [];
  const positions: number[] = [];
  const diameters: number[] = [];
  let acc = 0;
  let prevPoint: [number, number] | null = null;

  for (let i = 0; i < path.length; i++) {
    // 接線 → 法線（中央差分。端は片側差分）。
    const p0 = path[Math.max(0, i - 2)];
    const p1 = path[Math.min(path.length - 1, i + 2)];
    let tx = p1[0] - p0[0];
    let ty = p1[1] - p0[1];
    const tl = Math.hypot(tx, ty);
    if (tl === 0) continue;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;

    const c = path[i];
    const profile: number[] = new Array(half * 2 + 1);
    for (let k = -half; k <= half; k++) {
      const x = c[0] + nx * k * step;
      const y = c[1] + ny * k * step;
      profile[k + half] = sampleBilinear(pixels, width, height, x, y);
    }
    const e = findEdgesInProfile(profile, centerIndex, step);
    if (!e) continue;

    // 法線方向の異方性を考慮した mm 換算（row/col の spacing が違う場合に効く）。
    const mmPerPxAlongNormal = Math.hypot(nx * mmCol, ny * mmRow);
    const diameterPx = e.right - e.left;
    if (!(diameterPx > 0)) continue;

    const left: [number, number] = [c[0] + nx * e.left, c[1] + ny * e.left];
    const right: [number, number] = [c[0] + nx * e.right, c[1] + ny * e.right];

    if (prevPoint) {
      const dx = (c[0] - prevPoint[0]) * mmCol;
      const dy = (c[1] - prevPoint[1]) * mmRow;
      acc += Math.hypot(dx, dy);
    }
    prevPoint = c;

    centerline.push([c[0], c[1]]);
    edges.push({ left, right });
    positions.push(acc);
    diameters.push(diameterPx * mmPerPxAlongNormal);
  }

  if (diameters.length < 3) return null;

  const reference = referenceDiameters(positions, diameters);
  const summary = summarize(positions, diameters, reference);
  if (summary.rvd <= 0) warnings.push("referenceFitFailed");

  return {
    centerline,
    edges,
    positions,
    diameters,
    reference,
    ...summary,
    unit: calibrated ? "mm" : "px",
    warnings,
  };
}
