/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 統計エンジン。**すべての ROI 種別・開閉を 1 本の経路で計算する**（`fw/roi-stats-design.md`）。
 *
 * <h3>なぜ自前で持つのか</h3>
 * Cornerstone3D はツールごとに統計の実装がバラバラで、**矩形・楕円・フリーハンド(閉) は
 * mean/SD/min/max まで出すのに、ポリゴン(閉) は面積だけ、ポリゴンライン(開) は何も出さない**
 * （`SplineROITool._calculateCachedStats` が `if (!data.contour.closed) return;` で抜ける）。
 * さらに上流は `voxelManager` から生のモダリティ値を読むため、**SUV 校正を知らない**
 * ——PET を SUV 校正しても ROI の平均は Bq/mL のまま出る。
 *
 * <p>本モジュールは画素を必ず {@link ./pixelCalibration} 経由で読む（CLAUDE.md ルール 2）ので、
 * HU も SUV も XA の px/mm も自動的に正しくなる。
 *
 * <h3>2 段構成</h3>
 * 「閉でも開でも測れる統計量を出す」の実装上の答えは、**サンプル集合の作り方だけを分け、
 * 要約統計は共通にする**こと。
 * <pre>
 *   面型(閉) → メッシュを塗って内部画素      ┐
 *   線型(開) → メッシュ上を等間隔サンプル    ┼→ summarizeValues() → RoiValueStats
 *   点型     → 最近傍 1 画素                 ┘
 * </pre>
 *
 * <h3>面積はメッシュで統一する</h3>
 * 🔴 報告する面積は**閉多角形（メッシュ）のシューレース面積**であり、ラスタ画素数 × 画素面積では
 * ない。両者は境界画素の扱いで数 % ずれ、小さい ROI ほど量子化で跳ねる。面積は形状の量であって
 * 画素の量ではない。ラスタの画素数は {@link RoiGeometryStats#sampleCount} として**別項目**で出す。
 *
 * <p>ツールごとの特別扱いは {@link buildRoiMesh} の中だけに閉じ込める。そこから先は
 * 「閉多角形 or 折れ線」という 1 つの表現しか流れない。
 */
import { analyzeValues, type HistogramData } from "./histogram";
import { computeCalipers, convexHull, type PointPx } from "./roiRead";

/** ROI から画素値をどう拾うか。 */
export type RoiSampleKind = "area" | "line" | "point" | "none";

/**
 * ROI の形（画素座標）。**すべての ROI 種別がここへ潰れる**。
 * 閉多角形では始点を末尾で繰り返さない（辺 `n-1 → 0` は暗黙）。
 */
export interface RoiMesh {
  pointsPx: PointPx[];
  closed: boolean;
}

/** 形から決まる量（画素値を読まなくても出る）。 */
export interface RoiGeometryStats {
  kind: RoiSampleKind;
  /** 面積 (mm²)。閉のみ。画素間隔が無ければ `undefined`（mm を捏造しない）。 */
  areaMm2?: number;
  /** 面積 (px²)。閉のみ。 */
  areaPx2?: number;
  /** 閉=周囲長 / 開=折れ線長 (mm)。画素間隔が無ければ `undefined`。 */
  perimeterMm?: number;
  /** 同 (px)。 */
  perimeterPx?: number;
  /** RECIST 語彙の長径 (mm)。`roiRead.computeCalipers()` と同じ定義。 */
  longAxisMm?: number;
  /** 長径に直交する方向の広がり (mm)。 */
  shortAxisMm?: number;
  /** 重心（画素座標）。 */
  centroidPx?: [number, number];
  /** [minX, minY, maxX, maxY]（画素座標）。 */
  bboxPx?: [number, number, number, number];
  /** **統計に使った画素（サンプル）の数**。面積とは別物（上記「面積はメッシュで統一する」）。 */
  sampleCount: number;
  /** 面内の画素間隔が取れたか。false なら mm 系は全部 `undefined`。 */
  spatiallyCalibrated: boolean;
}

/** 画素値から決まる量。単位は `unit`（"HU" / "SUVbw" / "raw" 等）。 */
export interface RoiValueStats {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  median: number;
  sum: number;
  p5: number;
  p95: number;
  skewness: number;
  /** 過剰尖度（正規分布 = 0）。 */
  kurtosis: number;
  /** シャノンエントロピー（底 2）。**ビン数に依存する**（{@link ENTROPY_BINS}）。 */
  entropy: number;
  unit: string;
}

/** 開 ROI の線プロファイル。`distance` の単位は `distanceUnit`。 */
export interface RoiProfile {
  distance: Float32Array;
  values: Float32Array;
  distanceUnit: "mm" | "px";
}

export interface RoiStatsResult {
  roiUid: string;
  tool: string;
  /** どの画像で計算したか。グローバル ROI（z:"all"）では「いま見ているスライス」を指す。 */
  imageId: string;
  geometry: RoiGeometryStats;
  values?: RoiValueStats;
  profile?: RoiProfile;
  /** 要約統計と**同じ母集団**のヒストグラム。詳細表示を求められたときだけ入る。 */
  histogram?: HistogramData;
  computedAt: number;
  /** 出せなかった理由。`"no-spacing"` / `"no-pixels"` / `"unsupported-tool"` / `"empty-mesh"` */
  warnings: string[];
}

/**
 * 楕円・円をメッシュ化するときの分割数。
 *
 * <p>多角形近似の面積は真値の `sin(π/N)/(π/N)` 倍になる。**N=360 で相対誤差 1.3×10⁻⁵**
 * ＝ 10 mm² の ROI で 1.3×10⁻⁴ mm² なので表示桁に出ない。マジックナンバーにせず定数にして、
 * テストで「πab との相対誤差 < 1e-4」を固定してある。
 */
export const ELLIPSE_MESH_SEGMENTS = 360;

/**
 * エントロピー算出のビン数。
 *
 * <p>エントロピーは**定義上ビン数に依存する**（連続値そのものには定義できない）。
 * 表示側では必ずビン数を添えること。256 は 8bit 慣用値。
 */
export const ENTROPY_BINS = 256;

/** 線プロファイルのサンプル間隔（画素単位）。0.5px = ナイキストの目安。 */
export const PROFILE_STEP_PX = 0.5;

/** 面型として扱うツール（小文字）。`closed === false` なら線型へ落ちる。 */
const AREA_TOOLS = new Set([
  "rectangleroi",
  "rectangleroithreshold",
  "ellipticalroi",
  "circleroi",
  "planarfreehandroi",
  "splineroi",
  "livewirecontour",
  "graphypolygonroi",
  "graphyfreehandroi",
]);

/**
 * 線型として扱うツール（**閉じることが無い**もの）。
 *
 * <p>ポリゴンライン / フリーラインは `roiContourTools` が描き終わりに必ず開くので、
 * `contour.closed` を見るまでもなく線型。**描いている途中は `closed` がまだ未定**で、
 * 面型として扱うと一瞬だけ面積が出る（「線を引いたのに面積が出る」）。名前で決め打つ。
 */
const LINE_TOOLS = new Set(["length", "graphypolylineroi", "graphyfreelineroi"]);

/** 点型。 */
const POINT_TOOLS = new Set(["probe", "dragprobe"]);

/**
 * そのツール／開閉から、画素値の拾い方を決める。純関数。
 *
 * <p>**Bidirectional / Angle / CobbAngle / ArrowAnnotate は `"none"`。**
 * Bidirectional は交差する 2 線分なので折れ線としてサンプルすると軌跡が意味を成さず、
 * 角度系は折れ線の頂点間に画素値としての意味が無い。`roiRead.hasShapeCalipers()` が
 * 同じ理由でこれらを除外しているのと揃えてある（**知らないツールには値を出さない**方が安全
 * ——数値が出ないのは気付けるが、意味の違う数値が出るのは気付けない）。
 */
export function pickSampleKind(tool: string, closed: boolean | undefined): RoiSampleKind {
  const t = (tool ?? "").trim().toLowerCase();
  if (POINT_TOOLS.has(t)) return "point";
  if (LINE_TOOLS.has(t)) return "line";
  if (AREA_TOOLS.has(t)) return closed === false ? "line" : "area";
  return "none";
}

// ───────────────────────── メッシュ ─────────────────────────

/** 楕円の 4 ハンドル [bottom, top, left, right] を閉多角形へ。純関数。 */
export function polygonizeEllipse(
  handlesPx: ReadonlyArray<PointPx>,
  segments: number = ELLIPSE_MESH_SEGMENTS,
): PointPx[] {
  if (handlesPx.length < 4) return [];
  // Cornerstone の EllipticalROI は handles.points = [bottom, top, left, right]
  // （`EllipticalROITool.js`: `const [bottom, top, left, right] = canvasCoordinates;`）。
  // 半軸ベクトルで持てば**ビューポートが回転していても**そのまま正しい。
  const [b, tp, l, r] = handlesPx;
  const cx = (b[0] + tp[0]) / 2;
  const cy = (b[1] + tp[1]) / 2;
  const ax = (tp[0] - b[0]) / 2;
  const ay = (tp[1] - b[1]) / 2;
  const bx = (r[0] - l[0]) / 2;
  const by = (r[1] - l[1]) / 2;
  const n = Math.max(8, Math.round(segments));
  const out: PointPx[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const c = Math.cos(th);
    const s = Math.sin(th);
    out.push([cx + ax * c + bx * s, cy + ay * c + by * s]);
  }
  return out;
}

/** 円の 2 ハンドル [center, edge] を閉多角形へ。純関数。 */
export function polygonizeCircle(
  handlesPx: ReadonlyArray<PointPx>,
  segments: number = ELLIPSE_MESH_SEGMENTS,
): PointPx[] {
  if (handlesPx.length < 2) return [];
  const [c, e] = handlesPx;
  const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
  if (!(r > 0)) return [];
  const n = Math.max(8, Math.round(segments));
  const out: PointPx[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    out.push([c[0] + r * Math.cos(th), c[1] + r * Math.sin(th)]);
  }
  return out;
}

/**
 * ROI をメッシュ（閉多角形 or 折れ線）へ落とす。純関数。**ツール差はここで吸収し切る。**
 *
 * @param tool     Cornerstone のツール名
 * @param pointsPx 頂点（画素座標）。輪郭系は `contour.polyline`、それ以外は `handles.points` 由来
 * @param closed   閉じているか（`contour.closed`。輪郭系以外は無視される）
 */
export function buildRoiMesh(
  tool: string,
  pointsPx: ReadonlyArray<PointPx>,
  closed: boolean | undefined,
  ellipseSegments: number = ELLIPSE_MESH_SEGMENTS,
): RoiMesh | null {
  const t = (tool ?? "").trim().toLowerCase();
  const kind = pickSampleKind(t, closed);
  if (kind === "none") return null;
  if (!pointsPx.length) return null;

  if (t === "ellipticalroi") {
    const poly = polygonizeEllipse(pointsPx, ellipseSegments);
    return poly.length ? { pointsPx: poly, closed: true } : null;
  }
  if (t === "circleroi") {
    const poly = polygonizeCircle(pointsPx, ellipseSegments);
    return poly.length ? { pointsPx: poly, closed: true } : null;
  }
  if (t === "rectangleroi" || t === "rectangleroithreshold") {
    // handles.points は 4 隅だが**並び順は操作したハンドルで入れ替わる**
    // （`RectangleROITool._dragCallback` が index 0/3 と 1/2 で別々に組み直す）。
    // 凸包に通せば順序に依らず正しい向きの 4 角形になる。
    const hull = convexHull(pointsPx);
    return hull.length >= 3 ? { pointsPx: hull, closed: true } : null;
  }
  if (kind === "point") return { pointsPx: [pointsPx[0]], closed: false };
  return { pointsPx: pointsPx.slice(), closed: kind === "area" };
}

/** 閉多角形の符号なし面積 (px²)。シューレース。開いていれば null。純関数。 */
export function meshAreaPx2(mesh: RoiMesh): number | null {
  if (!mesh.closed) return null;
  const p = mesh.pointsPx;
  if (p.length < 3) return null;
  let acc = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    acc += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  }
  return Math.abs(acc) / 2;
}

/**
 * 面積 (mm²)。画素座標 → mm は `(x·sx, y·sy)` の**アフィン写像**なので、
 * ヤコビアン `sx·sy` を掛ければよい（異方性画素でも正しい）。画素間隔が無ければ null。純関数。
 */
export function meshAreaMm2(
  mesh: RoiMesh,
  spacingX: number | null | undefined,
  spacingY: number | null | undefined,
): number | null {
  const a = meshAreaPx2(mesh);
  if (a === null) return null;
  if (!isPositive(spacingX) || !isPositive(spacingY)) return null;
  return a * (spacingX as number) * (spacingY as number);
}

/**
 * 周長（閉）／折れ線長（開）。**開閉で式を分けない**——閉じているときだけ最後の辺を足す。
 * `spacing` を省くと px 単位。純関数。
 */
export function meshLength(
  mesh: RoiMesh,
  spacingX: number = 1,
  spacingY: number = 1,
): number {
  const p = mesh.pointsPx;
  if (p.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < p.length; i++) total += segLength(p[i - 1], p[i], spacingX, spacingY);
  if (mesh.closed && p.length >= 3) total += segLength(p[p.length - 1], p[0], spacingX, spacingY);
  return total;
}

/** 長さ (mm)。画素間隔が無ければ null。純関数。 */
export function meshLengthMm(
  mesh: RoiMesh,
  spacingX: number | null | undefined,
  spacingY: number | null | undefined,
): number | null {
  if (!isPositive(spacingX) || !isPositive(spacingY)) return null;
  return meshLength(mesh, spacingX as number, spacingY as number);
}

/** 重心（画素座標）。閉なら多角形重心、開なら頂点の平均。純関数。 */
export function meshCentroidPx(mesh: RoiMesh): [number, number] | null {
  const p = mesh.pointsPx;
  if (!p.length) return null;
  if (mesh.closed && p.length >= 3) {
    let cx = 0;
    let cy = 0;
    let a2 = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const cross = p[j][0] * p[i][1] - p[i][0] * p[j][1];
      a2 += cross;
      cx += (p[j][0] + p[i][0]) * cross;
      cy += (p[j][1] + p[i][1]) * cross;
    }
    // 面積ゼロ（degenerate な多角形）では重心が定義できないので頂点平均へ落とす。
    if (Math.abs(a2) > 1e-12) return [cx / (3 * a2), cy / (3 * a2)];
  }
  let sx = 0;
  let sy = 0;
  for (const q of p) {
    sx += q[0];
    sy += q[1];
  }
  return [sx / p.length, sy / p.length];
}

/** [minX, minY, maxX, maxY]（画素座標）。純関数。 */
export function meshBBoxPx(mesh: RoiMesh): [number, number, number, number] | null {
  const p = mesh.pointsPx;
  if (!p.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of p) {
    if (q[0] < minX) minX = q[0];
    if (q[0] > maxX) maxX = q[0];
    if (q[1] < minY) minY = q[1];
    if (q[1] > maxY) maxY = q[1];
  }
  return [minX, minY, maxX, maxY];
}

// ───────────────────────── サンプリング ─────────────────────────

/**
 * 閉メッシュを塗って内部画素の値を集める。純関数。
 *
 * <p>**面積を出したのと同じ多角形を塗る**のが眼目（`roiBooleanOps.rasterizeRoi` を使わない理由）。
 * 別の図形式で塗ると「面積 12.4 mm² なのに使用画素は 12.9 mm² 相当」という食い違いが出る。
 * 判定は画素中心 `(x+0.5, y+0.5)` の偶奇則。
 *
 * @returns ROI 内の画素値（順序は row-major）。1 画素も入らなければ空配列
 */
export function sampleInsideMesh(
  mesh: RoiMesh,
  values: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array {
  const box = meshBBoxPx(mesh);
  if (!box || !mesh.closed || mesh.pointsPx.length < 3) return new Float32Array(0);
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(width - 1, Math.ceil(box[2]));
  const y1 = Math.min(height - 1, Math.ceil(box[3]));
  if (x1 < x0 || y1 < y0) return new Float32Array(0);

  const out: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, mesh.pointsPx)) out.push(values[y * width + x]);
    }
  }
  // 塗り幅が 1 画素未満で 1 つも入らない極小 ROI は、最寄り 1 画素で代表させる
  // （「小さすぎて測れない」より「1 画素の値」の方が使える。n=1 は表に出る）。
  if (!out.length) {
    const c = meshCentroidPx(mesh);
    const v = c ? nearestValue(c[0], c[1], values, width, height) : null;
    if (v !== null) out.push(v);
  }
  return Float32Array.from(out);
}

/**
 * 折れ線（開メッシュ）に沿って**物理的に等間隔**でサンプルする。純関数。
 *
 * <p>ステップは mm 空間で取る（異方性画素では px 等間隔 ≠ 物理等間隔）。画素値は双一次補間。
 * `spacing` を省くと px 空間になり、`distanceUnit` が `"px"` になる。
 */
export function sampleAlongMesh(
  mesh: RoiMesh,
  values: ArrayLike<number>,
  width: number,
  height: number,
  spacingX: number | null | undefined,
  spacingY: number | null | undefined,
  stepPx: number = PROFILE_STEP_PX,
): RoiProfile | null {
  const p = mesh.pointsPx;
  if (p.length < 2) return null;
  const calibrated = isPositive(spacingX) && isPositive(spacingY);
  const sx = calibrated ? (spacingX as number) : 1;
  const sy = calibrated ? (spacingY as number) : 1;
  // 「stepPx 画素ぶん」を物理長へ。異方性なら短い方の辺に合わせて取りこぼしを避ける。
  const step = Math.max(1e-6, stepPx * Math.min(sx, sy));

  const segs: { a: PointPx; b: PointPx; len: number }[] = [];
  let total = 0;
  const push = (a: PointPx, b: PointPx) => {
    const len = segLength(a, b, sx, sy);
    if (len > 0) {
      segs.push({ a, b, len });
      total += len;
    }
  };
  for (let i = 1; i < p.length; i++) push(p[i - 1], p[i]);
  if (mesh.closed && p.length >= 3) push(p[p.length - 1], p[0]);
  if (!segs.length || !(total > 0)) return null;

  const n = Math.max(2, Math.floor(total / step) + 1);
  const distance = new Float32Array(n);
  const out = new Float32Array(n);
  let si = 0;
  let base = 0; // segs[si] の始点までの累積長
  for (let k = 0; k < n; k++) {
    const d = Math.min(total, k * step);
    while (si < segs.length - 1 && d > base + segs[si].len) {
      base += segs[si].len;
      si++;
    }
    const s = segs[si];
    const f = s.len > 0 ? Math.min(1, Math.max(0, (d - base) / s.len)) : 0;
    const x = s.a[0] + (s.b[0] - s.a[0]) * f;
    const y = s.a[1] + (s.b[1] - s.a[1]) * f;
    distance[k] = d;
    out[k] = bilinear(x, y, values, width, height);
  }
  return { distance, values: out, distanceUnit: calibrated ? "mm" : "px" };
}

// ───────────────────────── 要約統計 ─────────────────────────

/**
 * サンプル値の要約統計。純関数。空なら null。
 *
 * <p>🔴 **モーメント（分散・歪度・尖度）とエントロピーは {@link analyzeValues} に委譲する。**
 * 数式を 2 か所に書くと、同じ ROI について画面のどこを見たかで値が違うという事故になる。
 * 中央値・p5・p95 だけは**ソートした実値から厳密に**出す（ヒストグラムの中央値は
 * ビン内線形補間の推定値なので、要約表に載せるにはふさわしくない）。
 */
export function summarizeValues(values: ArrayLike<number>, unit: string): RoiValueStats | null {
  const n = values.length;
  if (!n) return null;
  // 非有限値（NaN/Inf）は母集団から外す。校正の欠けたスライスで NaN が混じり得る。
  const finite: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      finite.push(v);
      sum += v;
    }
  }
  if (!finite.length) return null;

  const h = analyzeValues([finite], unit, { mode: "count", value: ENTROPY_BINS });
  const sorted = finite.slice().sort((a, b) => a - b);
  return {
    n: finite.length,
    mean: h.mean,
    sd: h.stdDev,
    min: h.min,
    max: h.max,
    median: percentile(sorted, 0.5),
    sum,
    p5: percentile(sorted, 0.05),
    p95: percentile(sorted, 0.95),
    skewness: h.skewness,
    kurtosis: h.kurtosis,
    entropy: h.entropy,
    unit,
  };
}

/** 要約統計と同じ母集団のヒストグラム（詳細表示用）。ビン指定は呼び出し側。 */
export function roiHistogram(
  values: ArrayLike<number>,
  unit: string,
  binCount: number = ENTROPY_BINS,
): HistogramData | null {
  if (!values.length) return null;
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite.push(values[i]);
  if (!finite.length) return null;
  return analyzeValues([finite], unit, { mode: "count", value: binCount });
}

// ───────────────────────── 組み立て ─────────────────────────

/** {@link computeRoiStatsFrom} の入力。Cornerstone に触れない形に解決済みのもの。 */
export interface RoiStatsInput {
  roiUid: string;
  tool: string;
  imageId: string;
  /** 頂点（画素座標）。`roiRead.roiPointsPx()` で解決したもの。 */
  pointsPx: ReadonlyArray<PointPx>;
  /** 輪郭が閉じているか（`data.contour.closed`）。輪郭系以外は undefined でよい。 */
  closed?: boolean;
  /** 校正済み画素（`pixelCalibration.readModalitySlice()`）。無ければ幾何だけ出す。 */
  slice?: { values: ArrayLike<number>; width: number; height: number } | null;
  /** 値の単位（`pixelCalibration.resolveValueUnit()`）。 */
  unit: string;
  spacingX: number | null | undefined;
  spacingY: number | null | undefined;
  /** 開 ROI の線プロファイルも作るか（詳細表示のときだけ true）。 */
  withProfile?: boolean;
  /** ヒストグラムも作るか（詳細表示のときだけ true）。要約統計と**同じ母集団**から作る。 */
  withHistogram?: boolean;
}

/**
 * 統計を組み立てる。**純関数**（Cornerstone に触れない＝テストできる）。
 * 画素が無ければ幾何だけ返し、`warnings` に理由を入れる。
 */
export function computeRoiStatsFrom(input: RoiStatsInput): RoiStatsResult {
  const { roiUid, tool, imageId, pointsPx, closed, slice, unit, spacingX, spacingY } = input;
  const warnings: string[] = [];
  const kind = pickSampleKind(tool, closed);
  const calibrated = isPositive(spacingX) && isPositive(spacingY);
  if (!calibrated) warnings.push("no-spacing");

  const base: RoiStatsResult = {
    roiUid,
    tool,
    imageId,
    geometry: { kind, sampleCount: 0, spatiallyCalibrated: calibrated },
    computedAt: Date.now(),
    warnings,
  };
  if (kind === "none") {
    warnings.push("unsupported-tool");
    return base;
  }

  const mesh = buildRoiMesh(tool, pointsPx, closed);
  if (!mesh || !mesh.pointsPx.length) {
    warnings.push("empty-mesh");
    return base;
  }

  const geometry: RoiGeometryStats = { kind, sampleCount: 0, spatiallyCalibrated: calibrated };
  const centroid = meshCentroidPx(mesh);
  if (centroid) geometry.centroidPx = centroid;
  const bbox = meshBBoxPx(mesh);
  if (bbox) geometry.bboxPx = bbox;

  if (kind === "area") {
    const aPx = meshAreaPx2(mesh);
    if (aPx !== null) geometry.areaPx2 = aPx;
    const aMm = meshAreaMm2(mesh, spacingX, spacingY);
    if (aMm !== null) geometry.areaMm2 = aMm;
  }
  if (kind !== "point") {
    geometry.perimeterPx = meshLength(mesh);
    const lMm = meshLengthMm(mesh, spacingX, spacingY);
    if (lMm !== null) geometry.perimeterMm = lMm;
    // 長径・短径は `roiRead.computeCalipers()` と同じ定義（凸包上の最遠 2 点と直交幅）だが、
    // ここではメッシュの頂点に対して掛ける（楕円なら多角形化後＝真の長軸・短軸に一致する）。
    const cal = computeCalipers(mesh.pointsPx, spacingX, spacingY);
    if (cal) {
      geometry.longAxisMm = cal.longAxisMm;
      geometry.shortAxisMm = cal.shortAxisMm;
    }
  }

  if (!slice || !slice.width || !slice.height) {
    warnings.push("no-pixels");
    return { ...base, geometry };
  }

  let samples: Float32Array;
  let profile: RoiProfile | undefined;
  if (kind === "area") {
    samples = sampleInsideMesh(mesh, slice.values, slice.width, slice.height);
  } else if (kind === "line") {
    const pr = sampleAlongMesh(mesh, slice.values, slice.width, slice.height, spacingX, spacingY);
    samples = pr ? pr.values : new Float32Array(0);
    if (pr && input.withProfile) profile = pr;
  } else {
    const p = mesh.pointsPx[0];
    const v = nearestValue(p[0], p[1], slice.values, slice.width, slice.height);
    samples = v === null ? new Float32Array(0) : Float32Array.of(v);
  }
  geometry.sampleCount = samples.length;

  const values = summarizeValues(samples, unit) ?? undefined;
  if (!values) warnings.push("no-pixels");
  // ヒストグラムは要約統計と同じサンプル集合から作る（別経路にすると数字が食い違う）。
  const histogram = input.withHistogram && values ? (roiHistogram(samples, unit) ?? undefined) : undefined;
  return { ...base, geometry, values, profile, histogram };
}

// ───────────────────────── 小物（非公開） ─────────────────────────

function isPositive(v: number | null | undefined): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function segLength(a: PointPx, b: PointPx, sx: number, sy: number): number {
  return Math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy);
}

/** 偶奇則（画素中心での内外判定）。`roiBooleanOps.pointInPoly` と同じ式。 */
function pointInPolygon(px: number, py: number, poly: ReadonlyArray<PointPx>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearestValue(
  x: number,
  y: number,
  values: ArrayLike<number>,
  width: number,
  height: number,
): number | null {
  const ix = Math.min(width - 1, Math.max(0, Math.round(x - 0.5)));
  const iy = Math.min(height - 1, Math.max(0, Math.round(y - 0.5)));
  if (!(width > 0) || !(height > 0)) return null;
  const v = values[iy * width + ix];
  return Number.isFinite(v) ? v : null;
}

/** 双一次補間。画素中心を (i+0.5, j+0.5) とみなし、外周はクランプする。 */
function bilinear(
  x: number,
  y: number,
  values: ArrayLike<number>,
  width: number,
  height: number,
): number {
  const fx = Math.min(width - 1, Math.max(0, x - 0.5));
  const fy = Math.min(height - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = values[y0 * width + x0];
  const v10 = values[y0 * width + x1];
  const v01 = values[y1 * width + x0];
  const v11 = values[y1 * width + x1];
  return (
    v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
  );
}

/** ソート済み配列の分位点（線形補間）。 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const f = pos - lo;
  return sorted[lo] * (1 - f) + sorted[hi] * f;
}
