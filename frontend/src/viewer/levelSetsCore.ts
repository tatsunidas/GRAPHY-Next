/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Level Sets セグメンテーション、純粋アルゴリズム部分（DOM/Worker 非依存、`levelSetsWorker.ts` から呼ばれる）。
 *
 * Fast Marching Method（Sethian の古典的単一パス・優先度キュー方式）の実装。dims.depth=1 なら 2D として動作する。
 * fw/level-sets-design.md §1.3 の数式を踏まえるが、独自のクリーンルーム実装であり、GPL の
 * `fiji/level_sets` ソースの翻訳ではない（同ドキュメント §1.0 参照）。
 *
 * Fiji の Distance threshold は「1 反復ごとに凍結する trial point の割合」という、UI スレッド上で
 * 段階的に進捗表示するための実装都合の値だが、本実装は 1 回の Worker 呼び出しで完結させるため、
 * より標準的な「シードからの最大到達距離（コスト距離）」という停止条件に置き換えている。
 */

export interface Dims {
  cols: number;
  rows: number;
  depth: number; // 2D は 1
}

export interface FastMarchingInput {
  image: Float32Array; // cols*rows*depth、生の画素値
  dims: Dims;
  seedX: number;
  seedY: number;
  seedZ: number;
  greyValueThreshold: number; // シードとの輝度差がこれを超えたら到達不能（境界）
  distanceThreshold: number; // シードからの最大到達距離（コスト距離）。0 以下は無制限
}

export interface FastMarchingResult {
  mask: Uint8Array; // cols*rows*depth、1=segmented
  reachedCount: number;
}

/** 輝度差コストの重み（Fiji のデフォルト値 ALPHA=0.005 を踏襲）。 */
const ALPHA = 0.005;
/** 暴走防止の上限（`wandTool.ts` の MAX_VOXELS と同じ発想）。 */
const MAX_VOXELS = 4_000_000;

class MinHeap {
  private items: { idx: number; time: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(idx: number, time: number): void {
    const items = this.items;
    items.push({ idx, time });
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p].time <= items[i].time) break;
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  }

  pop(): { idx: number; time: number } | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as { idx: number; time: number };
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = i * 2 + 2;
        let smallest = i;
        if (l < items.length && items[l].time < items[smallest].time) smallest = l;
        if (r < items.length && items[r].time < items[smallest].time) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function idxOf(x: number, y: number, z: number, dims: Dims): number {
  return (z * dims.rows + y) * dims.cols + x;
}

const NEI_2D: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
const NEI_3D: [number, number, number][] = [...NEI_2D, [0, 0, 1], [0, 0, -1]];

export function runFastMarching(input: FastMarchingInput): FastMarchingResult {
  const { image, dims, seedX, seedY, seedZ, greyValueThreshold, distanceThreshold } = input;
  const n = dims.cols * dims.rows * dims.depth;
  const ALIVE = 2;
  const BAND = 1;
  const state = new Uint8Array(n); // 既定 FAR(0)
  const time = new Float64Array(n).fill(Infinity);
  const neighbors = dims.depth > 1 ? NEI_3D : NEI_2D;
  const seedIdx = idxOf(seedX, seedY, seedZ, dims);
  const seedValue = image[seedIdx];
  const maxTime = distanceThreshold > 0 ? distanceThreshold : Infinity;

  const heap = new MinHeap();
  state[seedIdx] = ALIVE;
  time[seedIdx] = 0;

  const cost = (idx: number): number => {
    const diff = Math.abs(image[idx] - seedValue);
    if (diff > greyValueThreshold) return Infinity; // 到達不能（境界）
    return 1 + ALPHA * diff;
  };

  const pushTrial = (idx: number, t: number): void => {
    if (state[idx] === ALIVE) return;
    if (t < time[idx]) {
      time[idx] = t;
      state[idx] = BAND;
      heap.push(idx, t);
    }
  };

  const expandFrom = (x: number, y: number, z: number): void => {
    const baseIdx = idxOf(x, y, z, dims);
    const baseTime = time[baseIdx];
    for (const [dx, dy, dz] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx < 0 || nx >= dims.cols || ny < 0 || ny >= dims.rows || nz < 0 || nz >= dims.depth) continue;
      const nIdx = idxOf(nx, ny, nz, dims);
      if (state[nIdx] === ALIVE) continue;
      const c = cost(nIdx);
      if (!Number.isFinite(c)) continue;
      const t = baseTime + c;
      if (t <= maxTime) pushTrial(nIdx, t);
    }
  };

  expandFrom(seedX, seedY, seedZ);

  let reachedCount = 1;
  while (heap.size > 0 && reachedCount < MAX_VOXELS) {
    const top = heap.pop() as { idx: number; time: number };
    if (state[top.idx] === ALIVE) continue; // 重複エントリ
    if (top.time !== time[top.idx]) continue; // 古いエントリ（更新済み）
    state[top.idx] = ALIVE;
    reachedCount++;
    const z = Math.floor(top.idx / (dims.cols * dims.rows));
    const rem = top.idx - z * dims.cols * dims.rows;
    const y = Math.floor(rem / dims.cols);
    const x = rem - y * dims.cols;
    expandFrom(x, y, z);
  }

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = state[i] === ALIVE ? 1 : 0;

  return { mask, reachedCount };
}

// ─────────────────────────────────────────────────────────────────────────
// Active Contours（narrow-band level set、L2）
//
// fw/level-sets-design.md §1.0/§1.3 で確認した Fiji（`fiji/level_sets`, GPL-2）の
// `ActiveContours.getDeltaPhi` と同一の speed function を、独自の TypeScript 実装として書き下したもの
// （クリーンルーム実装。GPL ソースの翻訳ではない）。
//
// Fiji 本体は Whitaker の Sparse Field Method（レイヤーリストによる active set 管理）だが、本実装は
// 実装コストを抑えるため簡略化した narrow-band 法（φ を全域 Float64Array で保持し、|φ|<=narrowBand の
// 画素のみ更新、一定間隔で符号付き距離関数へ再初期化）を採用する。数式（image term / advection term /
// curvature term）は Fiji と同一だが、反復エンジンの実装は異なる。
// ─────────────────────────────────────────────────────────────────────────

export type RegionExpandsTo = "inside" | "outside";

export interface ActiveContoursInput {
  image: Float32Array; // cols*rows、生の画素値（2D のみ、depth=1 前提）
  dims: Dims;
  initMask: Uint8Array; // 1 = 初期輪郭の内側
  regionExpandsTo: RegionExpandsTo;
  advection: number; // 0 = 使わない
  curvature: number; // 0 = 使わない
  grayscaleTolerance: number;
  convergence: number; // 反復間の平均 |Δφ| がこれを下回ったら収束
  narrowBand: number; // 帯域半幅（px）。Fiji の UI には無い、本実装独自の追加パラメータ
  reinitInterval: number; // 再初期化間隔（反復数）
  maxIterations: number; // 内部安全弁（UI 非露出）
}

export interface ActiveContoursResult {
  mask: Uint8Array;
  iterations: number;
  converged: boolean;
  lastChange: number;
}

const SQRT2 = Math.SQRT2;
const DIST_NEIGHBORS_2D: { dx: number; dy: number; w: number }[] = (() => {
  const out: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      out.push({ dx, dy, w: dx !== 0 && dy !== 0 ? SQRT2 : 1 });
    }
  }
  return out;
})();

function isBoundaryPixel(mask: Uint8Array, dims: Dims, x: number, y: number): boolean {
  const v = mask[idxOf(x, y, 0, dims)];
  const left = x > 0 ? mask[idxOf(x - 1, y, 0, dims)] : v;
  const right = x < dims.cols - 1 ? mask[idxOf(x + 1, y, 0, dims)] : v;
  const up = y > 0 ? mask[idxOf(x, y - 1, 0, dims)] : v;
  const down = y < dims.rows - 1 ? mask[idxOf(x, y + 1, 0, dims)] : v;
  return left !== v || right !== v || up !== v || down !== v;
}

/** mask の 0/1 境界からの符号なし距離場（多始点 Dijkstra、8 近傍・対角 √2 重み）。maxDist 超は Infinity のまま。 */
function unsignedDistanceToBoundary(mask: Uint8Array, dims: Dims, maxDist: number) {
  const n = mask.length;
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (let y = 0; y < dims.rows; y++) {
    for (let x = 0; x < dims.cols; x++) {
      if (isBoundaryPixel(mask, dims, x, y)) {
        const idx = idxOf(x, y, 0, dims);
        dist[idx] = 0;
        heap.push(idx, 0);
      }
    }
  }
  while (heap.size > 0) {
    const top = heap.pop() as { idx: number; time: number };
    if (top.time !== dist[top.idx] || top.time > maxDist) continue;
    const y = Math.floor(top.idx / dims.cols);
    const x = top.idx - y * dims.cols;
    for (const nb of DIST_NEIGHBORS_2D) {
      const nx = x + nb.dx;
      const ny = y + nb.dy;
      if (nx < 0 || nx >= dims.cols || ny < 0 || ny >= dims.rows) continue;
      const nIdx = idxOf(nx, ny, 0, dims);
      const t = top.time + nb.w;
      if (t < dist[nIdx] && t <= maxDist) {
        dist[nIdx] = t;
        heap.push(nIdx, t);
      }
    }
  }
  return dist;
}

/**
 * mask から符号付き距離関数 φ を構築する。`negWhenMaskIs`（0 か 1）と一致する画素側を φ<0 にする。
 * `regionExpandsTo` に応じて「初期輪郭の内側」がどちらの符号になるかを決める（fw/level-sets-design.md §1.0-4）:
 * outside（既定）= 内側が φ<0（確定/成長の起点）、inside = 内側が φ>0（外側から侵食される対象）。
 */
function buildSignedDistance(mask: Uint8Array, dims: Dims, negWhenMaskIs: 0 | 1, band: number) {
  const n = mask.length;
  const clampDist = Math.max(band * 4, 8);
  const unsigned = unsignedDistanceToBoundary(mask, dims, clampDist);
  const phi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = Number.isFinite(unsigned[i]) ? unsigned[i] : clampDist;
    phi[i] = mask[i] === negWhenMaskIs ? -d : d;
  }
  return phi;
}

/** 初期輪郭（mask）の境界画素の平均輝度。Active Contours の image term が比較する基準値（fw/level-sets-design.md §1.0-2）。 */
export function computeBoundaryMeanGreyValue(image: Float32Array, mask: Uint8Array, dims: Dims): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < dims.rows; y++) {
    for (let x = 0; x < dims.cols; x++) {
      if (isBoundaryPixel(mask, dims, x, y)) {
        sum += image[idxOf(x, y, 0, dims)];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

function gradMagnitude(image: ArrayLike<number>, dims: Dims) {
  const n = image.length;
  const g = new Float64Array(n);
  for (let y = 0; y < dims.rows; y++) {
    for (let x = 0; x < dims.cols; x++) {
      const idx = idxOf(x, y, 0, dims);
      const xB = x > 0 ? image[idxOf(x - 1, y, 0, dims)] : image[idx];
      const xF = x < dims.cols - 1 ? image[idxOf(x + 1, y, 0, dims)] : image[idx];
      const yB = y > 0 ? image[idxOf(x, y - 1, 0, dims)] : image[idx];
      const yF = y < dims.rows - 1 ? image[idxOf(x, y + 1, 0, dims)] : image[idx];
      const gx = (xF - xB) / 2;
      const gy = (yF - yB) / 2;
      g[idx] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return g;
}

/** エントロピー条件を満たす upwind スキームによる前線拡張速度項（常に ≥0）。Fiji `ActiveContours.getAdvectionTerm` と同型。 */
function advectionUpwindTerm(phi: Float64Array, dims: Dims, x: number, y: number): number {
  const idx = idxOf(x, y, 0, dims);
  const cell = phi[idx];
  const xB = phi[idxOf(x - 1, y, 0, dims)];
  const xF = phi[idxOf(x + 1, y, 0, dims)];
  const yB = phi[idxOf(x, y - 1, 0, dims)];
  const yF = phi[idxOf(x, y + 1, 0, dims)];
  const xBd = Math.max(cell - xB, 0);
  const xFd = Math.min(xF - cell, 0);
  const yBd = Math.max(cell - yB, 0);
  const yFd = Math.min(yF - cell, 0);
  return Math.sqrt(xBd * xBd + xFd * xFd + yBd * yBd + yFd * yFd);
}

/** 中心差分による平均曲率項（× |∇φ|）。Fiji `ActiveContours.getCurvatureTerm` と同型。 */
function curvatureTerm(phi: Float64Array, dims: Dims, x: number, y: number): number {
  const idx = idxOf(x, y, 0, dims);
  const c = phi[idx];
  const xB = phi[idxOf(x - 1, y, 0, dims)];
  const xF = phi[idxOf(x + 1, y, 0, dims)];
  const yB = phi[idxOf(x, y - 1, 0, dims)];
  const yF = phi[idxOf(x, y + 1, 0, dims)];
  const phiX = (xF - xB) / 2;
  const phiY = (yF - yB) / 2;
  if (phiX === 0 || phiY === 0) return 0;
  const phiXX = xF + xB - 2 * c;
  const phiYY = yF + yB - 2 * c;
  const phiXY =
    (phi[idxOf(x + 1, y + 1, 0, dims)] - phi[idxOf(x + 1, y - 1, 0, dims)] -
      phi[idxOf(x - 1, y + 1, 0, dims)] + phi[idxOf(x - 1, y - 1, 0, dims)]) / 4;
  const grad = Math.sqrt(phiX * phiX + phiY * phiY);
  const kappa =
    (-1 * (phiXX * phiY * phiY + phiYY * phiX * phiX - 2 * phiX * phiY * phiXY)) /
    Math.pow(phiX * phiX + phiY * phiY, 1.5);
  return kappa * grad;
}

export function runActiveContours(input: ActiveContoursInput): ActiveContoursResult {
  const {
    image, dims, initMask, regionExpandsTo, advection, curvature, grayscaleTolerance,
    convergence, narrowBand, reinitInterval, maxIterations,
  } = input;
  const n = image.length;
  const negWhenMaskIs: 0 | 1 = regionExpandsTo === "outside" ? 1 : 0;
  let phi = buildSignedDistance(initMask, dims, negWhenMaskIs, narrowBand);
  let phiNext = new Float64Array(n);
  const seedGreyValue = computeBoundaryMeanGreyValue(image, initMask, dims);
  const grad = gradMagnitude(image, dims);
  const EPS = 1e-3;
  const deltaT = 1 / (6 * Math.max(curvature, EPS) * Math.max(advection, EPS));

  let iterations = 0;
  let lastChange = Infinity;
  let converged = false;

  while (iterations < maxIterations) {
    phiNext.set(phi);
    let totalChange = 0;
    let updated = 0;
    for (let y = 1; y < dims.rows - 1; y++) {
      for (let x = 1; x < dims.cols - 1; x++) {
        const idx = idxOf(x, y, 0, dims);
        if (Math.abs(phi[idx]) > narrowBand) continue;
        const greyDiff = Math.abs(image[idx] - seedGreyValue);
        const greyPenalty = Math.max(greyDiff - grayscaleTolerance, 0);
        const imageTerm = 1 / (1 + (grad[idx] + greyPenalty) * 2);
        const advTerm = advectionUpwindTerm(phi, dims, x, y);
        const curvTerm = curvatureTerm(phi, dims, x, y);
        const d = -deltaT * imageTerm * (advection * advTerm + curvature * curvTerm);
        phiNext[idx] = phi[idx] + d;
        totalChange += Math.abs(d);
        updated++;
      }
    }
    const tmp = phi;
    phi = phiNext;
    phiNext = tmp;
    iterations++;
    if (updated === 0) {
      converged = true;
      break;
    }
    lastChange = totalChange / updated;
    if (lastChange < convergence) {
      converged = true;
      break;
    }
    if (reinitInterval > 0 && iterations % reinitInterval === 0) {
      const negMask = new Uint8Array(n);
      for (let i = 0; i < n; i++) negMask[i] = phi[i] < 0 ? 1 : 0;
      phi = buildSignedDistance(negMask, dims, 1, narrowBand);
    }
  }

  const mask = new Uint8Array(n);
  const wantNeg = regionExpandsTo === "outside";
  for (let i = 0; i < n; i++) mask[i] = phi[i] < 0 === wantNeg ? 1 : 0;

  return { mask, iterations, converged, lastChange };
}

// ─────────────────────────────────────────────────────────────────────────
// Geodesic Active Contours（L3）
//
// fw/level-sets-design.md §1.3 で確認した Fiji（`fiji/level_sets`, GPL-2）の
// `GeodesicActiveContour.getDeltaPhi` と役割は同じだが、advection 項は Fiji の実装をそのまま真似ず、
// 教科書的な GAC（Caselles et al., IJCV 22:61 / ITK GeodesicActiveContourLevelSetImageFilter）の定式化
// 「dφ/dt = g(x)[propagation・|∇φ| + curvature・κ|∇φ|] + advection・∇g・∇φ」に基づく独自実装とする
// （§1.3 で記録済みの通り、Fiji のソースの advection 項は符号の取り方に起因して片側分岐が事実上死んでいる
// ように見えるため、それを忠実再現するのではなく、方向ごとに正しく upwind を選ぶ標準的な実装にした）。
// Propagation/Curvature 項は Active Contours と同じ `advectionUpwindTerm`/`curvatureTerm` を再利用し、
// エッジ停止関数 g で重み付けする。
// ─────────────────────────────────────────────────────────────────────────

export interface GeodesicActiveContoursInput {
  image: Float32Array;
  dims: Dims;
  initMask: Uint8Array;
  regionExpandsTo: RegionExpandsTo;
  advection: number; // 0 = 使わない。エッジへの吸着（∇g・∇φ upwind）
  propagation: number; // 0 = 使わない。g で重み付けした拡張力
  curvature: number; // 0 = 使わない。g で重み付けした平滑化
  edgeSigma: number; // エッジマップ用ガウス平滑化 σ（Fiji には無い本実装独自の追加、§1.3）
  convergence: number;
  narrowBand: number;
  reinitInterval: number;
  maxIterations: number;
}

function gaussianKernel1D(sigma: number): number[] {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  return kernel.map((v) => v / sum);
}

/** 分離可能ガウスぼかし（水平→垂直の 2 パス）。端はクランプ。sigma<=0 なら原画像のコピーを返す。 */
function gaussianBlur(image: ArrayLike<number>, dims: Dims, sigma: number): Float64Array {
  const n = dims.cols * dims.rows;
  if (sigma <= 0) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = image[i];
    return out;
  }
  const kernel = gaussianKernel1D(sigma);
  const radius = (kernel.length - 1) / 2;
  const tmp = new Float64Array(n);
  for (let y = 0; y < dims.rows; y++) {
    for (let x = 0; x < dims.cols; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(dims.cols - 1, Math.max(0, x + k));
        acc += image[idxOf(sx, y, 0, dims)] * kernel[k + radius];
      }
      tmp[idxOf(x, y, 0, dims)] = acc;
    }
  }
  const out = new Float64Array(n);
  for (let y = 0; y < dims.rows; y++) {
    for (let x = 0; x < dims.cols; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(dims.rows - 1, Math.max(0, y + k));
        acc += tmp[idxOf(x, sy, 0, dims)] * kernel[k + radius];
      }
      out[idxOf(x, y, 0, dims)] = acc;
    }
  }
  return out;
}

function centralGradientComponents(field: Float64Array, dims: Dims, x: number, y: number): { gx: number; gy: number } {
  const idx = idxOf(x, y, 0, dims);
  const xB = x > 0 ? field[idxOf(x - 1, y, 0, dims)] : field[idx];
  const xF = x < dims.cols - 1 ? field[idxOf(x + 1, y, 0, dims)] : field[idx];
  const yB = y > 0 ? field[idxOf(x, y - 1, 0, dims)] : field[idx];
  const yF = y < dims.rows - 1 ? field[idxOf(x, y + 1, 0, dims)] : field[idx];
  return { gx: (xF - xB) / 2, gy: (yF - yB) / 2 };
}

/** 純粋移流項 u・∇φ の upwind 近似（u=(gx,gy)=∇g）。方向ごとに速度の符号で片側差分を選ぶ標準スキーム。 */
function advectionDotUpwind(phi: Float64Array, dims: Dims, x: number, y: number, gx: number, gy: number): number {
  const idx = idxOf(x, y, 0, dims);
  const cell = phi[idx];
  const xB = phi[idxOf(x - 1, y, 0, dims)];
  const xF = phi[idxOf(x + 1, y, 0, dims)];
  const yB = phi[idxOf(x, y - 1, 0, dims)];
  const yF = phi[idxOf(x, y + 1, 0, dims)];
  const dxUp = gx >= 0 ? cell - xB : xF - cell;
  const dyUp = gy >= 0 ? cell - yB : yF - cell;
  return gx * dxUp + gy * dyUp;
}

export function runGeodesicActiveContours(input: GeodesicActiveContoursInput): ActiveContoursResult {
  const {
    image, dims, initMask, regionExpandsTo, advection, propagation, curvature, edgeSigma,
    convergence, narrowBand, reinitInterval, maxIterations,
  } = input;
  const n = image.length;
  const negWhenMaskIs: 0 | 1 = regionExpandsTo === "outside" ? 1 : 0;
  let phi = buildSignedDistance(initMask, dims, negWhenMaskIs, narrowBand);
  let phiNext = new Float64Array(n);

  const smoothed = gaussianBlur(image, dims, edgeSigma);
  const gradMag = gradMagnitude(smoothed, dims);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = 1 / (1 + gradMag[i]);

  const EPS = 1e-3;
  const deltaT = 1 / (6 * Math.max(curvature, EPS) * Math.max(propagation, EPS) * Math.max(advection, EPS));

  let iterations = 0;
  let lastChange = Infinity;
  let converged = false;

  while (iterations < maxIterations) {
    phiNext.set(phi);
    let totalChange = 0;
    let updated = 0;
    for (let y = 1; y < dims.rows - 1; y++) {
      for (let x = 1; x < dims.cols - 1; x++) {
        const idx = idxOf(x, y, 0, dims);
        if (Math.abs(phi[idx]) > narrowBand) continue;
        const gv = g[idx];
        const { gx, gy } = centralGradientComponents(g, dims, x, y);
        const propTerm = advectionUpwindTerm(phi, dims, x, y) * gv;
        const curvTerm = curvatureTerm(phi, dims, x, y) * gv;
        const advTerm = advectionDotUpwind(phi, dims, x, y, gx, gy);
        const d = -deltaT * (propagation * propTerm + curvature * curvTerm) - deltaT * advection * advTerm;
        phiNext[idx] = phi[idx] + d;
        totalChange += Math.abs(d);
        updated++;
      }
    }
    const tmp = phi;
    phi = phiNext;
    phiNext = tmp;
    iterations++;
    if (updated === 0) {
      converged = true;
      break;
    }
    lastChange = totalChange / updated;
    if (lastChange < convergence) {
      converged = true;
      break;
    }
    if (reinitInterval > 0 && iterations % reinitInterval === 0) {
      const negMask = new Uint8Array(n);
      for (let i = 0; i < n; i++) negMask[i] = phi[i] < 0 ? 1 : 0;
      phi = buildSignedDistance(negMask, dims, 1, narrowBand);
    }
  }

  const mask = new Uint8Array(n);
  const wantNeg = regionExpandsTo === "outside";
  for (let i = 0; i < n; i++) mask[i] = phi[i] < 0 === wantNeg ? 1 : 0;

  return { mask, iterations, converged, lastChange };
}
