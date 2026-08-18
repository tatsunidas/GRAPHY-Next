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

/**
 * エッジの手修正（`fw/angio-design.md` §8.6）。
 *
 * <p>キーは**中心線（path）のインデックス**で、値は中心線からの**法線方向の符号付き
 * オフセット [px]**（left は負、right は正）。計測点インデックスではなく path インデックスに
 * するのは、自動検出が失敗して計測点から落ちた位置にも手でエッジを入れられるようにするため。
 *
 * <h3>🚨 token を必ず突き合わせる</h3>
 * 中心線が変わる（中間点を足す等）とインデックスの指す物理位置が変わる。**範囲内のまま
 * 別の場所を指す**ため、そのまま使うと「手で直したはずの点が違う場所に効く」という
 * 気づけない壊れ方をする。`QcaResult.centerlineToken` と一致しないときは使わずに
 * `edgeEditsDropped` を警告する。
 */
export interface QcaEdgeEdits {
  /** この編集が作られたときの中心線の識別子（`QcaResult.centerlineToken`）。 */
  token: string;
  byPathIndex: Readonly<Record<number, { left?: number; right?: number }>>;
}

/** 参照径（RVD）の決め方。 */
export type QcaReferenceMode =
  /** 全区間から健常部を推定して 1 次回帰（既定）。 */
  | { kind: "auto" }
  /** ユーザが「ここが健常」と指定した区間（計測点インデックスの閉区間）だけで回帰する。 */
  | { kind: "segments"; ranges: readonly (readonly [number, number])[] }
  /** 参照径を直接与える（他モダリティの実測値を使う等）。単位は結果と同じ。 */
  | { kind: "fixed"; diameter: number }
  /**
   * **区間の両端を健常と見なす**（QVA の既定・§9.1）。近位・遠位それぞれの窓の中央値を結び、
   * 間を線形で内挿する。
   *
   * <p>冠動脈の自動当てはめ（`auto`）は「区間の大半が健常」を前提にしているが、
   * **紡錘状の瘤は区間の大半を占めることがある**。そうなると瘤自身が参照径を押し上げ、
   * 「参照径に対する拡張」が測れなくなる。両端を基準にすればこれが起きない。
   *
   * <p>平均ではなく**中央値**を使う。解析区間の端は径が太く出ることがあり
   * （実測: 357 点中の端 6 点が 2.61 → 2.82mm）、平均だとそこに引かれる。
   */
  | { kind: "ends"; fraction?: number };

/**
 * 手修正（`fw/angio-design.md` §8.1「各段の結果を手で直せること」）。
 *
 * <p>臨床 QCA は「自動＋手修正」が前提。自動のみは受け入れられない。
 */
export interface QcaManualEdits {
  /**
   * 中心線を通す中間点（画像座標 px）。始点 → w1 → … → 終点 と**脚ごとに**最小経路を引く。
   * 自由曲線を描かせるのではなく経路探索に制約を与える方式なので、点を足すほど
   * ユーザの意図に寄りつつ、脚の中では画像に沿う。
   */
  waypoints?: readonly (readonly [number, number])[];
  /** エッジの手修正。 */
  edges?: QcaEdgeEdits | null;
  /** 解析区間の切り詰め（**計測点**インデックスの閉区間）。分岐や造影の切れ目を外すのに使う。 */
  trim?: { from: number; to: number } | null;
  /** 参照径の決め方（既定 auto）。 */
  reference?: QcaReferenceMode;
}

/** 手修正の出自。**保存物（SR / GSPS / レポート）に必ず出す**（自動値と同じ顔をさせない）。 */
export interface QcaProvenance {
  /** 中間点の数（0 なら中心線は自動のまま）。 */
  waypoints: number;
  /** 手で直したエッジの**計測点**インデックス（表示のハイライト用）。 */
  editedEdges: number[];
  /** 区間を切り詰めたか。 */
  trimmed: boolean;
  /** 参照径の決め方。 */
  reference: QcaReferenceMode["kind"];
  /**
   * **報告した径を何で測ったか**（§16.5）。⚠️ 画面に描く輪郭は常に半値法なので、
   * これが `densitometric` のときは**線と数値が別方式**。UI と SR に必ず出すこと。
   */
  diameterMethod: QcaDiameterMethod;
  /** 密度計測に使った μ [1/mm]（半値法なら null）。健常部の当てはめから得た値。 */
  muPerMm: number | null;
  /** 密度計測を使わなかった理由（使ったなら null）。**黙って落ちない**ための記録。 */
  densitometryFallback: string | null;
  /** どれか 1 つでも手が入っているか。 */
  edited: boolean;
}

export interface QcaInput {
  /** 画素値（校正済みモダリティ値。`readModalitySlice` の出力）。 */
  pixels: Float32Array;
  width: number;
  height: number;
  /** 解析区間の始点・終点（画像座標 px, 小数可）。 */
  start: [number, number];
  end: [number, number];
  /** 手修正（省略＝全自動）。 */
  edits?: QcaManualEdits | null;
  /** 行方向 mm/px（縦）。null なら px のまま返す。 */
  mmPerPxRow?: number | null;
  /** 列方向 mm/px（横）。 */
  mmPerPxCol?: number | null;
  /**
   * 血管が背景より暗いか。非サブトラクションの XA は true（造影剤で減衰＝暗い）、
   * DSA 後の差分画像は血管が正の大きな値になるので false。
   */
  vesselIsDark?: boolean;
  /**
   * プロファイルの値が何を表しているか。
   *
   * <p>🚨 **呼び出し側が `PixelIntensityRelationship (0028,1040)` から決めて渡すこと。**
   * 省略時は `vesselIsDark` から `intensity` / `attenuation` を選ぶが、これは
   * **LIN の装置でしか正しくない**。タグが無い XA を LOG とみなすのがこのアプリの慣行
   * （`dsa.ts` の `needsLogTransform`）なので、そちらでは `logIntensity` を渡す。
   */
  profileDomain?: QcaProfileDomain;
  /** 密度計測（§16.5）を使うか。既定 true。false なら常に半値法で報告する。 */
  densitometry?: boolean;
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
  /**
   * 各計測点の**法線**（単位ベクトル、画像座標）。エッジはこの向きに動かす。
   * UI が手修正のオフセットを作るのに要る。
   */
  normals: [number, number][];
  /** 各計測点のエッジ位置（中心線からの符号付き距離 [px]。left < 0 < right）。 */
  edgeOffsets: { left: number; right: number }[];
  /** 各計測点に対応する**中心線（path）インデックス**。手修正はこの番号で指定する。 */
  pathIndices: number[];
  /** 中心線の識別子。エッジ手修正の整合確認に使う（§8.6）。 */
  centerlineToken: string;
  /** 手修正の出自。 */
  provenance: QcaProvenance;
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
  /**
   * 面積狭窄率 [%]。
   *
   * <p>⚠️ 意味が**測り方で変わる**（§16.5）。半値法のときは `1 − (d_mld/d_rvd)²` ＝
   * **円形断面の仮定**。密度計測のときは径が既に面積等価直径なので、この式は
   * **面積の比そのもの**になり、断面の形の仮定は要らない（病変部について）。
   */
  percentAreaStenosis: number;
  /** 病変長（参照径を下回る連続区間）。 */
  lesionLength: number;
  /**
   * 径プロファイルの雑音尺度 σ̂（{@link profileNoiseScale}。単位は径と同じ）。
   * **病変長がどれだけ信用できるかの目安**——参照径の当てはめはこの幅の中で揺れる。
   */
  profileNoise: number;
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
 * 中間点を経由して中心線を引く（`fw/angio-design.md` §8.6）。
 *
 * <p>始点 → w1 → … → 終点 を**脚ごとに** {@link tracePath} で結び、継ぎ目の重複点を落として
 * 連結する。自由曲線を描かせず経路探索に制約を与える方式にしてあるので、中間点を足すほど
 * ユーザの意図に寄りつつ、脚の中では画像（血管）に沿う。
 *
 * <p>⚠️ 完全閉塞など**血管が見えない区間**では、脚が長いと経路は「それらしい」別の構造へ
 * 逃げる。その場合は中間点を細かく置いて脚を短くする（脚が数 px なら実質的に直線になる）。
 *
 * @returns 連結した経路。1 脚でも引けなければ null。
 */
export function traceCenterline(
  pixels: Float32Array,
  width: number,
  height: number,
  points: readonly (readonly [number, number])[],
  vesselIsDark: boolean,
  marginPx = 40,
): [number, number][] | null {
  if (points.length < 2) return null;
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a: [number, number] = [points[i][0], points[i][1]];
    const b: [number, number] = [points[i + 1][0], points[i + 1][1]];
    const leg = tracePath(pixels, width, height, a, b, vesselIsDark, marginPx);
    if (!leg || leg.length < 1) return null;
    // 継ぎ目（前の脚の終点 ＝ 次の脚の始点）が二重に入らないようにする。
    for (let k = out.length ? 1 : 0; k < leg.length; k++) out.push(leg[k]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * 中心線の識別子。
 *
 * <p>エッジ手修正は中心線インデックスで位置を指すので、中心線が変わると**範囲内のまま
 * 別の場所を指す**。それを検出するための指紋（0.25px 刻みで丸めた座標の FNV-1a）。
 */
export function centerlineToken(path: readonly (readonly [number, number])[]): string {
  let h = 2166136261 >>> 0;
  for (const p of path) {
    h = Math.imul(h ^ (Math.round(p[0] * 4) | 0), 16777619) >>> 0;
    h = Math.imul(h ^ (Math.round(p[1] * 4) | 0), 16777619) >>> 0;
  }
  return `${path.length}-${h.toString(36)}`;
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

/* ── 密度計測（A4c・§16.5）─────────────────────────────────────────── */

/**
 * プロファイルの値が何を表しているか。**密度計測はここを取り違えると黙って壊れる。**
 *
 * <p>`intensity` … 透過強度に比例（`PixelIntensityRelationship = LIN`・非サブトラクション）。
 * 減弱は **−ln(I/I_bg)**。
 * <p>`logIntensity` … **強度の対数**に比例（`= LOG`、および**タグが無い XA**——
 * `needsLogTransform()` の慣行）。血管は暗いが、**もう一度対数を取ってはいけない**。
 * 減弱は `I_bg − I` に比例する。
 * <p>`attenuation` … **すでに減弱**（DSA の出力 `log(mask) − log(live)`。§6）。血管が明るい。
 *
 * <h3>🔑 比例定数は気にしなくてよい</h3>
 * `logIntensity` / `attenuation` では減弱の比例定数（画素値の単位）が未知だが、
 * 面積は `Σa·間隔 / μ` で **a と μ に同じ定数が掛かる**ので約分される。
 * ⚠️ その代わり、この 2 つでは {@link QcaProvenance.muPerMm} は
 * **物理的な線減弱係数ではなく「画素値単位 / mm」**になる。数値をそのまま比較しない。
 */
export type QcaProfileDomain = "intensity" | "logIntensity" | "attenuation";

/** 径を何で測ったか。**数値と輪郭が別方式なので、必ず結果に持ち回る**（§16.5 の 2・3）。 */
export type QcaDiameterMethod = "half-max" | "densitometric";

/** 対数のゼロ除け（`dsa.ts` の `LOG_EPS` と同じ考え方）。 */
const LOG_EPS = 1e-6;

/**
 * 密度計測を諦めて半値法へ落とす雑音のしきい値（σ̂ ÷ 参照径）。
 *
 * <h3>🔑 この数字はファントムの実測から決めた（当てずっぽうではない）</h3>
 * GNBP-XA-1 の 11 フレームで、雑音を変えながら「病変の径の誤差」を両方式で測った:
 *
 * | 条件 | σ̂/RVD | 密度計測の誤差 | 半値法の誤差 |
 * | :- | -: | -: | -: |
 * | ノイズ無し | 0.000 | ≤ 3% | 13〜16%（90% 狭窄では **+79%**）|
 * | I0=20000 | 0.010 | 3.4% | 20% |
 * | I0=4000 | 0.018 | 10.8% | 19% |
 * | I0=800 | 0.041 | **31.9%** | 15% |
 *
 * **逆転するのは I0=800 と I0=4000 の間**なので、その間に置く。
 * ⚠️ 1 つのファントムで決めた値なので、**実データで測り直す余地がある**。
 */
const DENSITOMETRY_NOISE_LIMIT = 0.03;

/** μ の当てはめに使う健常部の点数（中央値を採るので奇数個あれば足りる）。 */
const MU_FIT_SAMPLES = 5;

/**
 * プロファイルを**背景を引いた減弱**に直す。
 *
 * <p>背景は**両端の中央値**で取る（片端だけだと、隣の血管や骨が乗った側に引きずられる）。
 * 対数を取ってから引く＝ `−ln(T/T_bg)` であって、`−ln(T) − T_bg` ではない。
 */
export function attenuationProfile(
  profile: readonly number[],
  domain: QcaProfileDomain,
): number[] {
  const n = profile.length;
  const a = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = profile[i];
    // logIntensity は「暗いほど減弱が大きい」ので符号を反転する。反転を忘れると
    // 減弱がすべて負になり、正の部分だけを積分する式が **0 を返す**（径が出ない）。
    a[i] = domain === "intensity" ? -Math.log(Math.max(v, LOG_EPS)) : domain === "logIntensity" ? -v : v;
  }
  const m = Math.max(3, Math.round(n * 0.05));
  const ends: number[] = [];
  for (let k = 0; k < m; k++) {
    ends.push(a[k], a[n - 1 - k]);
  }
  const bg = median(ends);
  for (let i = 0; i < n; i++) a[i] -= bg;
  return a;
}

/**
 * 密度計測の断面積 [mm²]（**断面の形を仮定しない**。§16.5 の M3）。
 *
 * <h3>なぜ形に依らないのか</h3>
 * ビール則より `−ln(I/I₀) = μ·L(d)`（L は視線が内腔を横切る長さ）。これを d について
 * 積分すると `∫L(d)dd = A`（断面積そのもの）になる。**円だと仮定していない**のが
 * 半値法・円柱当てはめとの決定的な違いで、実測でも楕円・三日月・D 型に対して
 * **0.4% 以内**で面積等価直径を返した（GNBP-XA-7・§16.5）。
 *
 * <h3>🔑 ぼけに厳密に強い</h3>
 * 畳み込みは**積分を保存する**ので、ぼけは −ln T を横へ広げても**総量を変えない**。
 * だから内腔がぼけ幅以下になっても面積の推定は生き残る（90% 狭窄で誤差 +3%。
 * 半値法は +79%）。エッジを探す方式は、エッジ自体が消える領域で原理的に負ける。
 *
 * <p>⚠️ **弱点はノイズ**。積分は窓全体の雑音を拾い、−ln は暗い画素の雑音を増幅する。
 * だから σ̂ が大きいときは半値法へ落とす（{@link runQca} の `densitometryFallback`）。
 * <p>⚠️ **重なった構造にも弱い**。隣の血管や骨の減弱まで積分するので、分岐部のように
 * 血管が投影で重なる場面では半値法より悪くなりうる（§21.4.3）。
 *
 * @param spacingMm プロファイルの**サンプル間隔** [mm]
 */
export function densitometricArea(
  attenuation: readonly number[],
  spacingMm: number,
  muPerMm: number,
): number | null {
  if (!(muPerMm > 0) || !(spacingMm > 0)) return null;
  let sum = 0;
  for (const v of attenuation) if (v > 0) sum += v;
  const area = (sum * spacingMm) / muPerMm;
  return area > 0 ? area : null;
}

/** 面積等価直径 [mm]。 */
export function densitometricDiameter(
  attenuation: readonly number[],
  spacingMm: number,
  muPerMm: number,
): number | null {
  const area = densitometricArea(attenuation, spacingMm, muPerMm);
  return area == null ? null : 2 * Math.sqrt(area / Math.PI);
}

/** ガウス核（`bench/experiment_qca_edge.py` と同じ約束: 端は値の複製で埋める）。 */
function blur1d(v: readonly number[], sigmaSamples: number): number[] {
  if (!(sigmaSamples > 0.01)) return [...v];
  const r = Math.max(1, Math.ceil(4 * sigmaSamples));
  const k = new Array<number>(2 * r + 1);
  let ksum = 0;
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-0.5 * (i / sigmaSamples) ** 2);
    k[i + r] = w;
    ksum += w;
  }
  for (let i = 0; i < k.length; i++) k[i] /= ksum;
  const n = v.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      const idx = Math.min(n - 1, Math.max(0, i + j));
      acc += v[idx] * k[j + r];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * 健常部のプロファイルに**ぼけ込みの円柱モデル**を当てはめて μ（線減弱係数 [1/mm]）を得る。
 *
 * <h3>🔑 形の仮定を健常部だけに閉じ込める</h3>
 * μ は実機では未知なので、どこかで形を仮定しないと決まらない。**健常部は円柱に近い**
 * という仮定はそこそこ妥当で、しかも**病変部には及ばない**——これが §16.5 で
 * 「M3（μ←健常部）」を選んだ理由（実測 健常 1.007・病変ノイズ無し 1.006）。
 *
 * <p>モデルは `T(d) = G_σ * exp(−μ·2√(r²−d²))` を減弱に直したもの。
 * ⚠️ **ぼけは強度に掛かるので、指数を取ってからぼかし、そのあと −ln に戻す**
 * （減弱を直接ぼかすと別物になる）。
 *
 * <p>⚠️ 実験（`bench/experiment_qca_edge.py` の `m4_cylinder_fit`）は σ を真値から
 * もらっていたが、**実機では σ も未知**なので (r, μ, σ) の 3 つを粗→細のグリッドで探す。
 * μ だけが欲しいので σ・r は捨てて構わない。
 *
 * @param attenuation 背景を引いた減弱プロファイル（{@link attenuationProfile}）
 * @param spacingMm サンプル間隔 [mm]
 */
export function fitCylinderMu(
  attenuation: readonly number[],
  spacingMm: number,
): { muPerMm: number; radiusMm: number; sigmaMm: number } | null {
  const n = attenuation.length;
  if (n < 9 || !(spacingMm > 0)) return null;
  const center = (n - 1) / 2;
  const d: number[] = new Array(n);
  for (let i = 0; i < n; i++) d[i] = (i - center) * spacingMm;

  // 中心の減弱 ≈ 2μr、半値幅 ≈ 2r から出した初期値の周りを探す。
  const peak = Math.max(...attenuation);
  if (!(peak > 1e-4)) return null;
  const halfWidthMm = attenuation.filter((v) => v >= peak / 2).length * spacingMm;
  const r0 = Math.max(spacingMm, halfWidthMm / 2);
  const mu0 = peak / (2 * r0);
  if (!(mu0 > 0) || !Number.isFinite(mu0)) return null;

  const residual = (r: number, mu: number, sigmaSamples: number): number => {
    const t = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const inner = r * r - d[i] * d[i];
      t[i] = Math.exp(-mu * 2 * Math.sqrt(Math.max(0, inner)));
    }
    const blurred = blur1d(t, sigmaSamples);
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const model = -Math.log(Math.max(blurred[i], LOG_EPS));
      const e = model - attenuation[i];
      sse += e * e;
    }
    return sse;
  };

  let bestR = r0;
  let bestMu = mu0;
  let bestSigma = Math.max(0.5, 0.5 / spacingMm);
  let best = Infinity;
  let rSpan = r0 * 0.6;
  let muSpan = mu0 * 0.6;
  let sSpan = bestSigma;
  const STEPS = 8;
  for (let level = 0; level < 4; level++) {
    const cR = bestR;
    const cMu = bestMu;
    const cS = bestSigma;
    for (let i = 0; i <= STEPS; i++) {
      const r = cR - rSpan + (2 * rSpan * i) / STEPS;
      if (!(r > 0)) continue;
      for (let j = 0; j <= STEPS; j++) {
        const mu = cMu - muSpan + (2 * muSpan * j) / STEPS;
        if (!(mu > 0)) continue;
        for (let k = 0; k <= STEPS; k++) {
          const s = cS - sSpan + (2 * sSpan * k) / STEPS;
          if (s < 0) continue;
          const sse = residual(r, mu, s);
          if (sse < best) {
            best = sse;
            bestR = r;
            bestMu = mu;
            bestSigma = s;
          }
        }
      }
    }
    rSpan /= STEPS / 2;
    muSpan /= STEPS / 2;
    sSpan /= STEPS / 2;
  }
  if (!Number.isFinite(best) || !(bestMu > 0)) return null;
  return { muPerMm: bestMu, radiusMm: bestR, sigmaMm: bestSigma * spacingMm };
}

/**
 * 径プロファイルの雑音尺度 σ̂（径と同じ単位）。**隣り合う点の差**の MAD から求める。
 *
 * <h3>なぜ「残差の散らばり」ではなく「隣との差」なのか</h3>
 * 残差を使うには先に参照径が要るが、その参照径を決めるのにこの尺度が要る（循環する）。
 * 隣との差なら**当てはめを持たずに**測れ、しかも
 * - 緩やかなテーパーは隣同士でほとんど変わらないので**傾きを雑音と誤認しにくい**、
 * - 病変は「少数の大きな差」なので**中央値が弾く**、
 * という 2 つの性質がそのまま欲しい性質になっている。
 * 係数は正規分布での一致性（MAD → σ が 1.4826 倍、差を取ると分散が 2 倍なので √2 で割る）。
 *
 * <p>⚠️ **急峻なテーパーは雑音として数えられる**（隣との差が大きくなるため）。
 * σ̂ は「安全側（大きめ）に出る」量として使うこと。
 */
export function profileNoiseScale(diameters: readonly number[]): number {
  const n = diameters.length;
  if (n < 3) return 0;
  const diffs: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) diffs[i - 1] = Math.abs(diameters[i] - diameters[i - 1]);
  return (1.4826 * median(diffs)) / Math.SQRT2;
}

/** 中央値（引数は破壊しない）。 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 参照径（健常部の当てはめ）。**外れ値を上下から落とす反復回帰**（2026-08-16 に作り直した）。
 *
 * <h3>🔴 なぜ作り直したか — 「当てはめ以上の点だけ残す」は端の数点に乗り上げる</h3>
 * 元の実装は `d ≥ 当てはめ` を満たす点だけで 2 回反復していた。**片側**の選別なので、
 * 解析区間の端で径が太く出る数点（実測: 357 点中 6 点が 2.61mm → 2.82mm）に当てはめが
 * 乗り上げ、**健常部の平坦部（2.609mm）が丸ごと参照径を下回る**。結果:
 * - 病変長 =「径が参照径を下回る連続区間」が**区間ほぼ全部**（実測 77.85mm / 真値 10mm）
 * - 狭窄が無い血管で %DS が 3.27%、参照径が真値 ×0.870 から 0.088mm ずれる
 *
 * <p>いまは残差の中央値と MAD で**上下対称に外れ値を落として**当てはめ直す（4 反復）。
 * 病変（深い外れ値）も端の膨らみ（高い外れ値）も同じ仕掛けで落ちる。実測（ファントム 11 枚）:
 * **参照径 2.609mm = 真値 ×0.870 ぴったり**・**狭窄無しの %DS = 0.00**・
 * **病変長の最大誤差 0.55mm**（作り直す前は最大 68mm）。
 *
 * <p>⚠️ MAD が壊れるのは外れ値が半数を超えたとき。**解析区間の半分以上を病変が占める指定**では
 * 参照径が病変側に寄る。区間の取り方の問題なので、ここでは直さない（UI で区間を指定し直す）。
 *
 * <p>この関数は径について**1 次同次**（すべての径を k 倍したら参照径も k 倍）。
 * %DS が校正の系統誤差（§16.4）に依らない根拠なので、ここは崩さないこと。
 *
 * @param userSegments ユーザが「ここが健常」と指定した閉区間（計測点インデックス）。
 *   与えられたら**その点だけ**を使い、反復による自動選別は行わない（人の指定が勝つ）。
 *
 *   <p>🚨 区間が**1 つだけ**なら傾きは当てはめず**定数**にする。短い窓で当てた傾きを
 *   区間の外まで延長すると、ノイズが増幅されて遠位で参照径が現実離れする
 *   （実機で「左端を健常と指定したら参照径が右へ向かって上り坂になる」形で出た）。
 *   近位と遠位の 2 区間を指定したときだけ、その間を線形で結ぶ（臨床 QCA の慣行と同じ）。
 */
export function referenceDiameters(
  positions: readonly number[],
  diameters: readonly number[],
  userSegments?: readonly (readonly [number, number])[] | null,
): number[] {
  const n = diameters.length;
  if (n === 0) return [];

  if (userSegments && userSegments.length) {
    const picked: boolean[] = new Array(n).fill(false);
    let count = 0;
    let ranges = 0;
    for (const [a, b] of userSegments) {
      const lo = Math.max(0, Math.min(Math.round(a), Math.round(b)));
      const hi = Math.min(n - 1, Math.max(Math.round(a), Math.round(b)));
      if (lo > hi) continue;
      ranges++;
      for (let i = lo; i <= hi; i++) {
        if (!picked[i]) {
          picked[i] = true;
          count++;
        }
      }
    }
    if (count >= 1) {
      // 区間 1 つ → 定数。2 つ以上 → その間を線形で結ぶ（テーパーを表現できる）。
      if (ranges < 2) {
        let sum = 0;
        for (let i = 0; i < n; i++) if (picked[i]) sum += diameters[i];
        const mean = sum / count;
        return positions.map(() => mean);
      }
      return fitLine(positions, diameters, picked);
    }
  }

  if (n < 3) return diameters.map((d) => d);
  let include = new Array<boolean>(n).fill(true);
  let line = fitLine(positions, diameters, include);
  for (let iter = 0; iter < 4; iter++) {
    const resid = diameters.map((d, i) => d - line[i]);
    const center = median(resid);
    // MAD = 0（＝平坦なプロファイル）でも帯が潰れないよう、径に比例した下限を置く。
    const scale = Math.max(
      1.4826 * median(resid.map((r) => Math.abs(r - center))),
      1e-6 * Math.abs(median(diameters)),
    );
    const next = new Array<boolean>(n);
    let kept = 0;
    for (let i = 0; i < n; i++) {
      next[i] = Math.abs(resid[i] - center) <= 2.5 * scale;
      if (next[i]) kept++;
    }
    if (kept < 3) break;
    include = next;
    line = fitLine(positions, diameters, include);
  }
  return line;
}

/** `include[i]` が真の点だけで 1 次回帰し、全点での当てはめ値を返す（点が足りなければ平均）。 */
function fitLine(positions: readonly number[], diameters: readonly number[], include: readonly boolean[]): number[] {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < diameters.length; i++) {
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
    return positions.map(() => mean);
  }
  const a = (sw * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / sw;
  return positions.map((p) => a * p + b);
}

/**
 * 病変の判定を健常部の平坦部から離すための余裕（参照径に対する比）。
 *
 * <p>🚨 **臨床的な閾値ではなく、同点をほどくためだけの値**。健常部では径がほぼ一定なので、
 * 参照径がそこにぴったり乗ると `径 < 参照径` の符号が最終桁の揺れで決まり、
 * 病変長が「数点」にも「区間全部」にもなる（実測で両方見た）。
 * 参照径 2.6mm に対して **2.6µm** ——エッジ検出の精度（0.05px ≒ 11µm）より 1 桁小さいので、
 * **本物のくぼみを隠すことはない**。
 */
const LESION_TIE_MARGIN = 0.0005;

/**
 * 病変の範囲（MLD を含む「径が参照径を下回る」連続区間）の**計測点インデックス**。
 *
 * <p>🚨 **2D QCA と 3D QCA でこの 1 本を共有する。** 同じ名前の量（病変長）が
 * 2 つの定義を持つと、どちらを見ているのか分からなくなる（§10.2.8）。
 *
 * <p>参照径が健常部の真ん中を通っていることが前提（{@link referenceDiameters}）。
 * **参照径が寄っているのを判定の閾値で埋め合わせない** —— 参照径が狂ったままなのに
 * 病変長だけそれらしい値になり、RVD と %DS の誤りが見えなくなる。
 */
/**
 * 区間の両端を健常と見なした参照径（QVA・{@link QcaReferenceMode} の `ends`）。
 *
 * @param fraction 端の窓の割合（既定 0.25 ＝ 前後 25% ずつ）
 */
export function referenceFromEnds(
  positions: readonly number[],
  diameters: readonly number[],
  fraction = 0.25,
): number[] {
  const n = diameters.length;
  if (n === 0) return [];
  if (n < 4) return diameters.map(() => median(diameters));
  const f = Number.isFinite(fraction) ? Math.min(0.5, Math.max(0.05, fraction)) : 0.25;
  const k = Math.max(1, Math.min(Math.floor(n / 2), Math.round(n * f)));
  const proxD = median(diameters.slice(0, k));
  const distD = median(diameters.slice(n - k));
  const proxP = median(positions.slice(0, k));
  const distP = median(positions.slice(n - k));
  if (!(distP > proxP)) return positions.map(() => (proxD + distD) / 2);
  const a = (distD - proxD) / (distP - proxP);
  const b = proxD - a * proxP;
  return positions.map((p) => a * p + b);
}

export function lesionBounds(
  diameters: readonly number[],
  reference: readonly number[],
  mldIndex: number,
): { lo: number; hi: number } {
  const below = (i: number): boolean => diameters[i] < reference[i] * (1 - LESION_TIE_MARGIN);
  let lo = mldIndex;
  while (lo - 1 >= 0 && below(lo - 1)) lo--;
  let hi = mldIndex;
  while (hi + 1 < diameters.length && below(hi + 1)) hi++;
  return { lo, hi };
}

/**
 * 拡張（瘤）の範囲 —— {@link lesionBounds} の上下を裏返したもの。
 *
 * <p>**同じ余裕（{@link LESION_TIE_MARGIN}）を使う**。狭窄と拡張で判定の厳しさが違うと、
 * 同じ血管の同じプロファイルで「狭窄長は短いのに拡張長は長い」といった非対称が出る。
 */
export function dilationBounds(
  diameters: readonly number[],
  reference: readonly number[],
  maxIndex: number,
): { lo: number; hi: number } {
  const above = (i: number): boolean => diameters[i] > reference[i] * (1 + LESION_TIE_MARGIN);
  let lo = maxIndex;
  while (lo - 1 >= 0 && above(lo - 1)) lo--;
  let hi = maxIndex;
  while (hi + 1 < diameters.length && above(hi + 1)) hi++;
  return { lo, hi };
}

/** 中心線に沿った径プロファイルの計測結果（QcaResult の一部）。 */
function summarize(
  positions: number[],
  diameters: number[],
  reference: number[],
): Pick<
  QcaResult,
  "mld" | "mldIndex" | "rvd" | "percentDiameterStenosis" | "percentAreaStenosis" | "lesionLength" | "profileNoise"
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

  const { lo, hi } = lesionBounds(diameters, reference, mldIndex);
  const lesionLength = Math.abs((positions[hi] ?? 0) - (positions[lo] ?? 0));

  return {
    mld,
    mldIndex,
    rvd,
    percentDiameterStenosis,
    percentAreaStenosis,
    lesionLength,
    profileNoise: profileNoiseScale(diameters),
  };
}

/** 1 つの中心線点での計測（手修正の適用前）。 */
interface QcaRow {
  pathIndex: number;
  point: [number, number];
  normal: [number, number];
  /** 中心線からの符号付きオフセット [px]。自動検出が失敗したら null。 */
  left: number | null;
  right: number | null;
  edited: boolean;
  /** 法線方向の生プロファイル。密度計測（§16.5）が要るので捨てずに持つ。 */
  profile: number[];
}

/** QCA 本体。失敗（中心線が引けない等）なら null。 */
export function runQca(input: QcaInput): QcaResult | null {
  const {
    pixels,
    width,
    height,
    start,
    end,
    edits,
    mmPerPxRow,
    mmPerPxCol,
    vesselIsDark = true,
    profileRadiusPx = 20,
    searchMarginPx = 40,
  } = input;
  const warnings: string[] = [];
  // プロファイルの値の意味。既定は表示用の `vesselIsDark` から決めるが、
  // **これは物理量の話**なので入力で上書きできるようにしてある（§16.5）。
  const domain: QcaProfileDomain = input.profileDomain ?? (vesselIsDark ? "intensity" : "attenuation");

  // ── ① 中心線（中間点があれば脚ごとに引く）─────────────────────────
  const waypoints = edits?.waypoints ?? [];
  const knots: [number, number][] = [start, ...waypoints.map((w) => [w[0], w[1]] as [number, number]), end];
  const raw = traceCenterline(pixels, width, height, knots, vesselIsDark, searchMarginPx);
  if (!raw || raw.length < 5) return null;
  // 中間点は**ユーザが決めた通過点**なので平滑化で動かさない。
  const path = smoothPathKeeping(raw, 5, joinIndices(raw, knots));
  const token = centerlineToken(path);

  // ── エッジ手修正の整合確認（§8.6）─────────────────────────────────
  let edgeEdits = edits?.edges ?? null;
  if (edgeEdits && edgeEdits.token !== token) {
    // 中心線が変わっている。インデックスは範囲内でも**別の場所**を指すので使わない。
    warnings.push("edgeEditsDropped");
    edgeEdits = null;
  }

  const calibrated = !!(mmPerPxRow && mmPerPxCol);
  const mmRow = mmPerPxRow ?? 1;
  const mmCol = mmPerPxCol ?? 1;
  if (!calibrated) warnings.push("uncalibrated");

  // プロファイルのサンプル間隔（サブピクセル）。0.25px で半値の線形補間が 0.05px 精度になる。
  const step = 0.25;
  const half = Math.round(profileRadiusPx / step);
  const centerIndex = half;

  // ── ② 各中心線点でエッジを取る（失敗しても行は残す＝手で入れられるように）───
  const rows: QcaRow[] = new Array(path.length);
  let prevNormal: [number, number] = [0, 1];
  for (let i = 0; i < path.length; i++) {
    // 接線 → 法線（中央差分。端は片側差分）。
    const p0 = path[Math.max(0, i - 2)];
    const p1 = path[Math.min(path.length - 1, i + 2)];
    let tx = p1[0] - p0[0];
    let ty = p1[1] - p0[1];
    const tl = Math.hypot(tx, ty);
    let normal: [number, number];
    if (tl === 0) {
      // 重複点。直前の法線を引き継ぐ（行を落とすと手修正のインデックスが飛ぶ）。
      normal = prevNormal;
    } else {
      tx /= tl;
      ty /= tl;
      normal = [-ty, tx];
    }
    prevNormal = normal;

    const c = path[i];
    const profile: number[] = new Array(half * 2 + 1);
    for (let k = -half; k <= half; k++) {
      profile[k + half] = sampleBilinear(pixels, width, height, c[0] + normal[0] * k * step, c[1] + normal[1] * k * step);
    }
    const e = findEdgesInProfile(profile, centerIndex, step);
    rows[i] = {
      pathIndex: i,
      point: [c[0], c[1]],
      normal,
      left: e ? e.left : null,
      right: e ? e.right : null,
      edited: false,
      profile,
    };
  }

  // ── ③ エッジの手修正を当てる ─────────────────────────────────────
  const editedPathIndices = new Set<number>();
  if (edgeEdits) {
    for (const [key, v] of Object.entries(edgeEdits.byPathIndex)) {
      const i = Number(key);
      const row = rows[i];
      if (!row || !v) continue;
      // 符号の約束（left<0<right）を破る値は無視する。UI のバグを黙って通さない。
      if (typeof v.left === "number" && Number.isFinite(v.left) && v.left < 0) {
        row.left = v.left;
        row.edited = true;
      }
      if (typeof v.right === "number" && Number.isFinite(v.right) && v.right > 0) {
        row.right = v.right;
        row.edited = true;
      }
      if (row.edited) editedPathIndices.add(i);
    }
  }

  // ── ④ 両側そろった点だけを計測点にする ───────────────────────────
  const complete = rows.filter((r) => r.left != null && r.right != null && (r.right as number) > (r.left as number));
  if (complete.length < 3) return null;

  // ── ⑤ 区間の切り詰め（計測点インデックス）─────────────────────────
  let kept = complete;
  const trim = edits?.trim ?? null;
  let trimmed = false;
  if (trim) {
    const lo = Math.max(0, Math.min(Math.round(trim.from), Math.round(trim.to)));
    const hi = Math.min(complete.length - 1, Math.max(Math.round(trim.from), Math.round(trim.to)));
    if (hi - lo + 1 >= 3) {
      kept = complete.slice(lo, hi + 1);
      trimmed = lo > 0 || hi < complete.length - 1;
    } else {
      warnings.push("trimTooShort");
    }
  }

  // ── ⑥ 径プロファイル ─────────────────────────────────────────────
  const centerline: [number, number][] = [];
  const edges: QcaEdge[] = [];
  const normals: [number, number][] = [];
  const edgeOffsets: { left: number; right: number }[] = [];
  const pathIndices: number[] = [];
  const positions: number[] = [];
  const diameters: number[] = [];
  const editedEdges: number[] = [];
  let acc = 0;
  let prevPoint: [number, number] | null = null;

  for (const r of kept) {
    const [nx, ny] = r.normal;
    const l = r.left as number;
    const rt = r.right as number;
    // 法線方向の異方性を考慮した mm 換算（row/col の spacing が違う場合に効く）。
    const mmPerPxAlongNormal = Math.hypot(nx * mmCol, ny * mmRow);

    if (prevPoint) {
      const dx = (r.point[0] - prevPoint[0]) * mmCol;
      const dy = (r.point[1] - prevPoint[1]) * mmRow;
      acc += Math.hypot(dx, dy);
    }
    prevPoint = r.point;

    if (r.edited) editedEdges.push(centerline.length);
    centerline.push([r.point[0], r.point[1]]);
    normals.push([nx, ny]);
    edgeOffsets.push({ left: l, right: rt });
    pathIndices.push(r.pathIndex);
    edges.push({
      left: [r.point[0] + nx * l, r.point[1] + ny * l],
      right: [r.point[0] + nx * rt, r.point[1] + ny * rt],
    });
    positions.push(acc);
    diameters.push((rt - l) * mmPerPxAlongNormal);
  }

  // ── ⑦ 参照径 ─────────────────────────────────────────────────────
  const refMode: QcaReferenceMode = edits?.reference ?? { kind: "auto" };
  const fitReference = (d: readonly number[]): number[] => {
    if (refMode.kind === "fixed") return positions.map(() => refMode.diameter);
    if (refMode.kind === "segments") return referenceDiameters(positions, d, refMode.ranges);
    if (refMode.kind === "ends") return referenceFromEnds(positions, d, refMode.fraction);
    return referenceDiameters(positions, d);
  };
  if (refMode.kind === "fixed" && !(refMode.diameter > 0)) return null;
  let reference = fitReference(diameters);
  let summary = summarize(positions, diameters, reference);

  // ── ⑦' 密度計測（A4c・§16.5）──────────────────────────────────────
  //
  // ここまでで作った半値法の径は**輪郭（画面に描く線）**として残し、**報告する径だけ**を
  // 密度計測で置き換える。半値法の係数は断面の形で 0.745〜0.918 まで動き（GNBP-XA-7）、
  // 内腔がぼけ幅以下だと符号が反転して過大になるので、**定数で補正しても直らない**。
  //
  // 🚨 **黙って切り替えない。** どちらで測ったかは必ず出自に残す（§16.5 の 3）。
  let diameterMethod: QcaDiameterMethod = "half-max";
  let muPerMm: number | null = null;
  let densitometryFallback: string | null = null;

  if (input.densitometry === false) {
    densitometryFallback = "disabled";
  } else if (!(summary.rvd > 0)) {
    densitometryFallback = "noReference";
  } else if (summary.profileNoise / summary.rvd > DENSITOMETRY_NOISE_LIMIT) {
    // ノイズが乗ると積分が窓全体の雑音を拾い、−ln が暗い画素の雑音を増幅する。
    densitometryFallback = "noisy";
  } else {
    // μ は**健常部**で当てはめる（形の仮定を健常部に閉じ込める）。参照径にいちばん近い
    // 点をいくつか使い、**中央値**を採る（1 点だけだとそこが実は病変でも気づけない）。
    const healthy = kept
      .map((_, i) => ({ i, dev: Math.abs(diameters[i] - reference[i]) / Math.max(reference[i], 1e-9) }))
      .sort((a, b) => a.dev - b.dev)
      .slice(0, MU_FIT_SAMPLES)
      .map((x) => x.i);
    const mus: number[] = [];
    for (const i of healthy) {
      const r = kept[i];
      const [nx, ny] = r.normal;
      const spacingMm = step * Math.hypot(nx * mmCol, ny * mmRow);
      const fit = fitCylinderMu(attenuationProfile(r.profile, domain), spacingMm);
      if (fit && fit.muPerMm > 0) mus.push(fit.muPerMm);
    }
    if (mus.length === 0) {
      densitometryFallback = "muFitFailed";
    } else {
      muPerMm = median(mus);
      const measured: number[] = new Array(kept.length);
      let ok = true;
      for (let i = 0; i < kept.length; i++) {
        const r = kept[i];
        const [nx, ny] = r.normal;
        const spacingMm = step * Math.hypot(nx * mmCol, ny * mmRow);
        const d = densitometricDiameter(attenuationProfile(r.profile, domain), spacingMm, muPerMm);
        if (d == null || !(d > 0)) {
          ok = false;
          break;
        }
        measured[i] = d;
      }
      if (!ok) {
        densitometryFallback = "profileFailed";
        muPerMm = null;
      } else {
        // 径だけ差し替える。**エッジ（輪郭）はそのまま**＝線と数値が別方式になるので UI に出す。
        for (let i = 0; i < measured.length; i++) diameters[i] = measured[i];
        reference = fitReference(diameters);
        summary = summarize(positions, diameters, reference);
        diameterMethod = "densitometric";
      }
    }
  }
  if (densitometryFallback && densitometryFallback !== "disabled") {
    warnings.push(`densitometryFallback:${densitometryFallback}`);
  }
  if (summary.rvd <= 0) warnings.push("referenceFitFailed");

  const provenance: QcaProvenance = {
    waypoints: waypoints.length,
    editedEdges,
    trimmed,
    reference: refMode.kind,
    diameterMethod,
    muPerMm,
    densitometryFallback,
    edited: waypoints.length > 0 || editedEdges.length > 0 || trimmed || refMode.kind !== "auto",
  };

  return {
    centerline,
    edges,
    normals,
    edgeOffsets,
    pathIndices,
    centerlineToken: token,
    provenance,
    positions,
    diameters,
    reference,
    ...summary,
    unit: calibrated ? "mm" : "px",
    warnings,
  };
}

/** 中間点（knot）が経路上のどのインデックスに落ちたかを求める（最近傍）。 */
function joinIndices(
  path: readonly (readonly [number, number])[],
  knots: readonly (readonly [number, number])[],
): number[] {
  const out: number[] = [];
  for (const k of knots) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < path.length; i++) {
      const d = (path[i][0] - k[0]) ** 2 + (path[i][1] - k[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    out.push(best);
  }
  return out;
}

/** {@link smoothPath} と同じだが、指定インデックスの点は動かさない（ユーザの通過点を尊重）。 */
function smoothPathKeeping(
  path: readonly [number, number][],
  window: number,
  fixedIndices: readonly number[],
): [number, number][] {
  const out = smoothPath(path, window);
  for (const i of fixedIndices) {
    if (i >= 0 && i < out.length) out[i] = [path[i][0], path[i][1]];
  }
  return out;
}
