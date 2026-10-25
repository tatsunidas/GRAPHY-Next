/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA 1 フレームから**血管の枝ツリー（2D）の候補**を自動で作る純関数（GN-XA-001 P2.5a）。
 *
 * <p>流れ: 多重スケールの線強調（Hessian）→ 雑音由来のしきい値（ヒステリシス）→ 2D 細線化（Zhang-Suen）
 * → 端点・分岐点でグラフ化 → 短いスパーの除去。**候補を出すだけ**で、採否は人が決める
 * （`fw/xa-confirm-ui-design.md`）。カテーテル・ワイヤ・骨・横隔膜も線として拾いうる（実画像は未検証）。
 *
 * <h3>既知の限界</h3>
 * <ul>
 *   <li>細線化で**枝の端が径の半分ほど縮む**（径 5 mm・0.3 mm/px で約 8 px）。</li>
 *   <li>径の範囲の両端（1 mm・5 mm 付近）では、余分な短い枝が出ることがある。</li>
 *   <li>雑音尺度の下限は量子化雑音（階調の刻み q の一様誤差、σ = q/√12）。画像の雑音がこれ以下なら
 *       warnings に `noiseAtQuantizationFloor` を付ける。雑音ゼロの合成画像では縁の肩の応答が残り、精度は保証しない。</li>
 *   <li>2 本の血管が画像上で重なる区間（中心線の距離が半径の和未満）は 1 つの塊になり、分岐点が
 *       約 (d1+d2)/(4·sin(θ/2)) だけ末梢側にずれる（d=径、θ=分岐角）。対応づけ側（P3）で扱う。</li>
 * </ul>
 *
 * <h3>しきい値とスケールの出どころ</h3>
 * <ul>
 *   <li>スケールは血管径の生理的範囲（{@link VESSEL_DIAMETER_RANGE_MM}）を `mmPerPx` で画素に換算して決める。
 *       **画素間隔が無ければ抽出しない**（近似の既定値で当てにいかない）。</li>
 *   <li>しきい値は、応答の中央値からの MAD（雑音の頑健な尺度）の倍率。倍率（{@link HYSTERESIS_SIGMA}）は
 *       測定の**前に固定**し、動かしても結果が変わらない範囲をテストで示す。最大化では選ばない。</li>
 *   <li>スパー（細線化の枝毛）と孤立した短い線は、**自分の径より短いもの**を落とす
 *       （径より短い線は、血管でなく塊か細線化の産物）。</li>
 * </ul>
 */

/** 冠動脈の内腔径の生理的な範囲 [mm]（患者面）。 */
export const VESSEL_DIAMETER_RANGE_MM: readonly [number, number] = [1.0, 5.0];

/** 低・高しきい値の、雑音尺度（MAD）に対する倍率。測定の前に固定した値。 */
export const HYSTERESIS_SIGMA: { low: number; high: number } = { low: 3, high: 6 };

/** 棒状の断面（幅 d）のガウス微分の最大応答スケール: σ = d / (2√3)。 */
const SIGMA_PER_DIAMETER = 1 / (2 * Math.sqrt(3));
/** サンプリング限界（これ未満の σ は画素間隔で解像できない）。 */
const MIN_SIGMA_PX = 0.8;
const SCALE_STEP = Math.SQRT2;

export interface XaVesselTreeOptions {
  /** 血管が暗い（造影 XA）なら true、明るい（DSA 等）なら false。 */
  vesselIsDark: boolean;
  /** 患者面の画素間隔 [mm/px]。無い（未校正）とき null。 */
  mmPerPx: number | null;
  /** 低・高しきい値の倍率（テストで平坦さを示すための上書き。通常は既定）。 */
  sigma?: { low: number; high: number };
}

export interface VesselTreeBranch {
  id: number;
  /** 画像 px（x, y）。start→end。 */
  pointsPx: [number, number][];
  lengthMm: number;
  /** 局所スケールから見積もった径の平均 [mm]。 */
  diameterMm: number;
  startNode: number;
  endNode: number;
}

export interface VesselTreeNode {
  id: number;
  posPx: [number, number];
  /** 接続する枝の数（1 = 端点、3 以上 = 分岐）。 */
  degree: number;
}

export type VesselTreeStatus = "ok" | "noScale" | "noVessel";

export interface XaVesselTree2D {
  status: VesselTreeStatus;
  nodes: VesselTreeNode[];
  branches: VesselTreeBranch[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 線強調                                                               */
/* ------------------------------------------------------------------ */

function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** 反射境界（端でのクランプは端に偽の山・谷を作るので使わない）。 */
function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  const p = 2 * (n - 1);
  let m = ((i % p) + p) % p;
  if (m >= n) m = p - m;
  return m;
}

function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const k = gaussKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const xx = reflect(x + i, w);
        a += k[i + r] * src[y * w + xx];
      }
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const yy = reflect(y + i, h);
        a += k[i + r] * tmp[yy * w + x];
      }
      out[y * w + x] = a;
    }
  }
  return out;
}

/**
 * 明るい線の強調。各スケールで σ² · max(0, −λ_min) を取り、全スケールの最大を返す。
 * `scaleIdx` は最大を与えたスケールの添字（局所の径の見積もりに使う）。
 */
function ridgeResponse(
  bright: Float32Array, w: number, h: number, sigmasPx: number[],
): { response: Float32Array; scaleIdx: Uint8Array } {
  const response = new Float32Array(w * h);
  const scaleIdx = new Uint8Array(w * h);
  sigmasPx.forEach((sigma, si) => {
    const g = blur(bright, w, h, sigma);
    const at = (x: number, y: number) => g[reflect(y, h) * w + reflect(x, w)];
    const s2 = sigma * sigma;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = at(x, y);
        const dxx = at(x + 1, y) - 2 * c + at(x - 1, y);
        const dyy = at(x, y + 1) - 2 * c + at(x, y - 1);
        const dxy = (at(x + 1, y + 1) - at(x - 1, y + 1) - at(x + 1, y - 1) + at(x - 1, y - 1)) / 4;
        const tr = dxx + dyy;
        const disc = Math.sqrt(Math.max(0, ((dxx - dyy) / 2) ** 2 + dxy * dxy));
        const lamMin = tr / 2 - disc;
        const resp = lamMin < 0 ? s2 * -lamMin : 0;
        const i = y * w + x;
        if (resp > response[i]) { response[i] = resp; scaleIdx[i] = si; }
      }
    }
  });
  return { response, scaleIdx };
}

/**
 * 画像の階調の刻み（量子化ステップ）。隣り合う異なる値の差の最小値。
 * 浮動小数の丸め誤差による微小な差（値域の 1e-6 未満）は刻みと見なさない。一定値の画像は 0。
 */
function quantizationStep(pixels: Float32Array): number {
  const s = Float32Array.from(pixels).sort();
  const floor = 1e-6 * (s[s.length - 1] - s[0]);
  let step = Infinity;
  for (let i = 1; i < s.length; i++) {
    const g = s[i] - s[i - 1];
    if (g > floor && g < step) step = g;
  }
  return Number.isFinite(step) ? step : 0;
}

/** 決定的な正規乱数（LCG + Box-Muller）。量子化雑音の応答を測る小片を作るためだけに使う。 */
function gaussianPatch(n: number, sd: number): Float32Array {
  let a = 12345;
  const u = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return (a + 0.5) / 4294967296; };
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = sd * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  return out;
}

function median(values: Float32Array): number {
  const s = Float32Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** ヒステリシス: 高しきい値を 1 画素でも含む 8 連結成分（低しきい値以上）を残す。 */
function hysteresis(resp: Float32Array, w: number, h: number, low: number, high: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < resp.length; i++) {
    if (resp[i] >= high && !out[i]) {
      out[i] = 1;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop() as number;
        const px = p % w, py = (p - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const q = ny * w + nx;
            if (!out[q] && resp[q] >= low) { out[q] = 1; stack.push(q); }
          }
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 細線化（Zhang-Suen）                                                  */
/* ------------------------------------------------------------------ */

function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const m = Uint8Array.from(mask);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const del: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          // P2..P9: 上から時計回り
          const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
          const b = p.reduce((a, v) => a + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) if (p[i] === 0 && p[(i + 1) % 8] === 1) a++;
          if (a !== 1) continue;
          if (pass === 0) {
            if (p[0] * p[2] * p[4] !== 0 || p[2] * p[4] * p[6] !== 0) continue;
          } else if (p[0] * p[2] * p[6] !== 0 || p[0] * p[4] * p[6] !== 0) continue;
          del.push(y * w + x);
        }
      }
      if (del.length) { changed = true; for (const i of del) m[i] = 0; }
    }
  }
  return m;
}

/**
 * 階段状の角を削る。Zhang-Suen の出力は斜めの線で 4 近傍の階段を残し、画素の次数が 3 になって
 * 偽の分岐点を量産する。**近傍が 8 近傍で 1 つにつながる**（＝消しても連結が変わらない）、端点でない画素を、
 * 1 画素ずつ順に消す。分岐点（近傍が互いに離れている）と端点は消えない。
 */
function removeStairCorners(skel: Uint8Array, w: number, h: number): Uint8Array {
  const m = Uint8Array.from(skel);
  const nb: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        const ns: [number, number][] = [];
        for (const [dx, dy] of nb) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && m[ny * w + nx]) ns.push([dx, dy]);
        }
        if (ns.length < 2) continue;
        // 近傍同士を 8 近傍でつないだ連結成分が 1 つか
        const seen = new Set<number>([0]);
        const stack = [0];
        while (stack.length) {
          const i = stack.pop() as number;
          for (let j = 0; j < ns.length; j++) {
            if (!seen.has(j) && Math.max(Math.abs(ns[i][0] - ns[j][0]), Math.abs(ns[i][1] - ns[j][1])) <= 1) { seen.add(j); stack.push(j); }
          }
        }
        if (seen.size === ns.length) { m[y * w + x] = 0; changed = true; }
      }
    }
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* グラフ化                                                             */
/* ------------------------------------------------------------------ */

const NEIGHBORS: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

interface RawGraph {
  nodePixels: number[][]; // ノードごとの画素 index
  branches: { pixels: number[]; a: number; b: number }[]; // pixels は a 側ノード画素から b 側ノード画素まで
}

function buildGraph(skel: Uint8Array, w: number, h: number): RawGraph {
  const deg = new Uint8Array(w * h);
  const neigh = (p: number): number[] => {
    const x = p % w, y = (p - x) / w;
    const out: number[] = [];
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && skel[ny * w + nx]) out.push(ny * w + nx);
    }
    return out;
  };
  for (let p = 0; p < skel.length; p++) if (skel[p]) deg[p] = neigh(p).length;

  // ノード画素: 端点（deg<=1）と分岐（deg>=3）。隣り合う分岐画素は 1 つのノードにまとめる。
  const nodeOf = new Int32Array(w * h).fill(-1);
  const nodePixels: number[][] = [];
  for (let p = 0; p < skel.length; p++) {
    if (!skel[p] || nodeOf[p] >= 0) continue;
    if (deg[p] === 2) continue;
    const id = nodePixels.length;
    const group = [p];
    nodeOf[p] = id;
    if (deg[p] >= 3) {
      for (let g = 0; g < group.length; g++) {
        for (const q of neigh(group[g])) if (nodeOf[q] < 0 && deg[q] >= 3) { nodeOf[q] = id; group.push(q); }
      }
    }
    nodePixels.push(group);
  }

  const visited = new Uint8Array(w * h);
  const branches: RawGraph["branches"] = [];
  const walk = (start: number, first: number, a: number) => {
    const pixels = [start];
    let prev = start, cur = first;
    while (true) {
      pixels.push(cur);
      if (nodeOf[cur] >= 0) { branches.push({ pixels, a, b: nodeOf[cur] }); return; }
      visited[cur] = 1;
      const next = neigh(cur).filter((q) => q !== prev && !(nodeOf[q] >= 0 && nodeOf[q] === a && pixels.length < 3));
      const nxt = next.find((q) => nodeOf[q] >= 0) ?? next.find((q) => !visited[q]);
      if (nxt === undefined) { branches.push({ pixels, a, b: a }); return; }
      prev = cur; cur = nxt;
    }
  };
  const used = new Set<string>();
  nodePixels.forEach((group, id) => {
    for (const p of group) {
      for (const q of neigh(p)) {
        if (nodeOf[q] === id) continue; // 同じノード内
        if (nodeOf[q] >= 0) {
          // ノード同士が直接隣り合う（長さ 1 の枝）
          const key = `${Math.min(p, q)}-${Math.max(p, q)}`;
          if (used.has(key)) continue;
          used.add(key);
          branches.push({ pixels: [p, q], a: id, b: nodeOf[q] });
          continue;
        }
        if (visited[q]) continue;
        walk(p, q, id);
      }
    }
  });
  // ノードを持たない閉じた輪（まれ）
  for (let p = 0; p < skel.length; p++) {
    if (skel[p] && !visited[p] && nodeOf[p] < 0) {
      const id = nodePixels.length;
      nodePixels.push([p]);
      nodeOf[p] = id;
      const first = neigh(p)[0];
      if (first === undefined) continue;
      walk(p, first, id);
    }
  }
  return { nodePixels, branches };
}

/* ------------------------------------------------------------------ */
/* 本体                                                                 */
/* ------------------------------------------------------------------ */

const polyLenPx = (pts: [number, number][]): number => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

export function extractVesselTree2D(
  pixels: Float32Array, width: number, height: number, opts: XaVesselTreeOptions,
): XaVesselTree2D {
  const empty = (status: VesselTreeStatus, warnings: string[]): XaVesselTree2D => ({ status, nodes: [], branches: [], warnings });
  const mm = opts.mmPerPx;
  if (!(typeof mm === "number" && mm > 0 && Number.isFinite(mm))) {
    return empty("noScale", ["noPixelSpacing"]);
  }

  const [dMin, dMax] = VESSEL_DIAMETER_RANGE_MM;
  const sigmasPx: number[] = [];
  const diamsMm: number[] = [];
  for (let d = dMin; d <= dMax * 1.0001; d *= SCALE_STEP) {
    const s = Math.max(MIN_SIGMA_PX, (d * SIGMA_PER_DIAMETER) / mm);
    if (sigmasPx.length && s <= sigmasPx[sigmasPx.length - 1] + 1e-6) continue;
    sigmasPx.push(s);
    diamsMm.push(s * mm / SIGMA_PER_DIAMETER);
  }

  const bright = new Float32Array(width * height);
  for (let i = 0; i < bright.length; i++) bright[i] = opts.vesselIsDark ? -pixels[i] : pixels[i];
  const { response, scaleIdx } = ridgeResponse(bright, width, height, sigmasPx);

  const med = median(response);
  const dev = new Float32Array(response.length);
  for (let i = 0; i < dev.length; i++) dev[i] = Math.abs(response[i] - med);
  // 雑音が数値上 0 の画像（雑音の無い合成画像）でも、ゼロ割りにならないよう下限を置く（実画像では効かない）。
  let maxResp = 0;
  for (let i = 0; i < response.length; i++) if (response[i] > maxResp) maxResp = response[i];
  const madNoise = 1.4826 * median(dev);
  // 雑音の下限は量子化雑音（階調の刻み q の一様誤差、σ = q/√12）。同じスケール列に通した応答の MAD を使う。
  // これより小さい雑音は、画像に格納された時点で存在しえない（雑音ゼロの合成画像で、縁の肩の応答を雑音扱いしないため）。
  const q = quantizationStep(pixels);
  let quantNoise = 0;
  if (q > 0) {
    const P = 96;
    const qResp = ridgeResponse(gaussianPatch(P, q / Math.sqrt(12)), P, P, sigmasPx).response;
    const qdev = new Float32Array(qResp.length);
    const qmed = median(qResp);
    for (let i = 0; i < qdev.length; i++) qdev[i] = Math.abs(qResp[i] - qmed);
    quantNoise = 1.4826 * median(qdev);
  }
  const warnings: string[] = madNoise < quantNoise ? ["noiseAtQuantizationFloor"] : [];
  // 階調の刻みが取れない（一定値の画像）ときのゼロ割り防止。
  const noise = Math.max(madNoise, quantNoise, 1e-6 * maxResp);
  const sg = opts.sigma ?? HYSTERESIS_SIGMA;
  if (!(noise > 0)) return empty("noVessel", warnings);
  const mask = hysteresis(response, width, height, med + sg.low * noise, med + sg.high * noise);

  // 稜線の画素を、その画素のスケールが表す半幅（√3·σ）の円板に膨らませてから細線化する。
  // 血管の縁の肩が作る細い線は、本来の血管の幅の内側に吸収され、中心線だけが残る。
  const filled = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const px0 = p % width, py0 = (p - px0) / width;
    const rad = Math.max(1, Math.sqrt(3) * sigmasPx[scaleIdx[p]]);
    const r2 = rad * rad, ri = Math.ceil(rad);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const nx = px0 + dx, ny = py0 + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) filled[ny * width + nx] = 1;
      }
    }
  }
  const skel = removeStairCorners(thin(filled, width, height), width, height);
  let g = buildGraph(skel, width, height);
  if (g.branches.length === 0) return empty("noVessel", warnings);

  // 枝ごとの径（その枝の画素のスケールから）と長さ。
  const branchDiamMm = (pix: number[]): number => {
    let s = 0;
    for (const p of pix) s += diamsMm[scaleIdx[p]];
    return s / pix.length;
  };
  const toPts = (pix: number[]): [number, number][] => pix.map((p) => [p % width, Math.floor(p / width)]);

  // 自分の径より短い枝を落とす（葉の枝・孤立した線）。分岐に挟まれた枝は残す。
  const nodeDegree = (branches: RawGraph["branches"], n: number) =>
    branches.reduce((a, b) => a + (b.a === n ? 1 : 0) + (b.b === n ? 1 : 0), 0);
  let branches = g.branches;
  for (let changed = true; changed;) {
    changed = false;
    const keep: typeof branches = [];
    for (const br of branches) {
      const lenMm = polyLenPx(toPts(br.pixels)) * mm;
      const leaf = br.a === br.b || nodeDegree(branches, br.a) === 1 || nodeDegree(branches, br.b) === 1;
      if (leaf && lenMm < branchDiamMm(br.pixels)) { changed = true; continue; }
      keep.push(br);
    }
    branches = keep;
  }
  // 分岐点が 1〜2 画素ずれて 2 つに割れ、間に径より短い枝ができることがある（骨格の曖昧さ）。1 つの分岐点にまとめる。
  const nodePixels = g.nodePixels.map((x) => x.slice());
  for (let changed = true; changed;) {
    changed = false;
    for (const br of branches) {
      if (br.a === br.b) continue;
      const lenMm = polyLenPx(toPts(br.pixels)) * mm;
      if (nodeDegree(branches, br.a) < 3 || nodeDegree(branches, br.b) < 3) continue;
      if (lenMm >= branchDiamMm(br.pixels)) continue;
      const from = br.b, into = br.a;
      branches = branches.filter((x) => x !== br);
      for (const x of branches) { if (x.a === from) x.a = into; if (x.b === from) x.b = into; }
      nodePixels[into] = nodePixels[into].concat(nodePixels[from]);
      nodePixels[from] = [];
      changed = true;
      break;
    }
  }
  g = { nodePixels, branches };

  // 次数 2 になったノードは枝をつないで消す。
  const merged: { pixels: number[]; a: number; b: number }[] = branches.map((b) => ({ ...b, pixels: b.pixels.slice() }));
  for (let changed = true; changed;) {
    changed = false;
    for (let n = 0; n < g.nodePixels.length; n++) {
      const inc = merged.filter((b) => b.a === n || b.b === n);
      if (inc.length !== 2 || inc[0] === inc[1]) continue;
      const orient = (b: typeof inc[0], atEnd: boolean) => (b.b === n === atEnd ? b.pixels : b.pixels.slice().reverse());
      const first = inc[0], second = inc[1];
      const firstPix = orient(first, true); // n で終わる向き
      const firstStart = first.b === n ? first.a : first.b;
      const secondPix = orient(second, false); // n から始まる向き
      const secondEnd = second.a === n ? second.b : second.a;
      const pix = firstPix.concat(secondPix.slice(1));
      merged.splice(merged.indexOf(first), 1);
      merged.splice(merged.indexOf(second), 1);
      merged.push({ pixels: pix, a: firstStart, b: secondEnd });
      changed = true;
      break;
    }
  }

  // ノードを詰め直して出力。
  const used = new Map<number, number>();
  const nodes: VesselTreeNode[] = [];
  const nodeId = (n: number): number => {
    const got = used.get(n);
    if (got !== undefined) return got;
    const grp = g.nodePixels[n];
    let sx = 0, sy = 0;
    for (const p of grp) { sx += p % width; sy += Math.floor(p / width); }
    const id = nodes.length;
    nodes.push({ id, posPx: [sx / grp.length, sy / grp.length], degree: 0 });
    used.set(n, id);
    return id;
  };
  const out: VesselTreeBranch[] = merged.map((b, i) => {
    const pts = toPts(b.pixels);
    const sn = nodeId(b.a), en = nodeId(b.b);
    nodes[sn].degree++; nodes[en].degree++;
    return { id: i, pointsPx: pts, lengthMm: polyLenPx(pts) * mm, diameterMm: branchDiamMm(b.pixels), startNode: sn, endNode: en };
  });
  if (out.length === 0) return empty("noVessel", warnings);
  return { status: "ok", nodes, branches: out, warnings };
}
