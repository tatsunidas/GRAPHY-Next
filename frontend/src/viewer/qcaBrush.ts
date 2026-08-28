/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QCA のエッジを**まとめて**直すブラシ（`fw/angio-design.md` §8.8）。純関数だけを置く。
 *
 * <h3>なぜ要るのか（実機で言われた・2026-08-27）</h3>
 * エッジの手修正は 1 点ずつ掴んで法線方向へ引く作りだった。計測点は数百あるので、
 * **自動エッジが外れた区間を直すのに何十回もドラッグする**ことになり、実用に耐えない。
 *
 * <h3>どう動かすか — 「押す」のであって「置く」のではない</h3>
 * 掴んだ点の**移動量 Δ** を、中心線に沿って近い点へ**重みを付けて配る**:
 *
 * <pre>
 *   offset_i ← offset_i + Δ · w(距離_i)
 * </pre>
 *
 * <p>🔴 **各点にポインタ位置を直接当てはめない。** 法線の向きは点ごとに違うので、
 * 離れた点にポインタの射影を当てると**血管の曲がりに沿って捻れる**。
 * 「いまの形からどれだけ動かすか」を配れば、**もとの形は保たれたまま区間全体が押される**。
 *
 * <p>重みは**弧長**（`QcaResult.positions`）で測る。計測点の番号で測ると、点の間隔が
 * 変わったときにブラシの効く範囲が変わってしまう。
 */

/** 重みの形。中心で 1、半径で 0、両端で傾き 0（＝境目に段差が出ない）。純関数。 */
export function brushWeight(distance: number, radius: number): number {
  if (!(radius > 0)) return distance === 0 ? 1 : 0;
  const d = Math.abs(distance);
  if (d >= radius) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / radius));
}

/** ブラシ 1 回ぶんの結果（そのまま `edgeEdits` へマージできる形）。 */
export interface BrushedEdge {
  pathIndex: number;
  side: "left" | "right";
  offset: number;
}

export interface BrushInput {
  /** 各計測点の弧長（`QcaResult.positions`。単位は mm または px）。 */
  positions: readonly number[];
  /** 計測点 → 中心線（path）インデックス（`QcaResult.pathIndices`）。 */
  pathIndices: readonly number[];
  /** 各計測点の現在のエッジ位置（`QcaResult.edgeOffsets`）。 */
  edgeOffsets: readonly { left: number; right: number }[];
  /** 掴んだ計測点。 */
  centerIndex: number;
  /** どちら側のエッジか。 */
  side: "left" | "right";
  /** 掴んだ点での**目標**オフセット（ポインタを法線へ射影した値）。 */
  targetOffset: number;
  /** ブラシ半径（`positions` と同じ単位）。 */
  radius: number;
}

/**
 * ブラシを 1 回当てた結果を返す。純関数。
 *
 * <p>掴んだ点は必ず目標値になり、そこから半径まで滑らかに減衰する。半径の外は触らない
 * （＝結果に含めない。含めると「動かしていないのに手修正済み」になる）。
 *
 * <p>符号は中心線をまたげない（左は負・右は正）。ここで潰すと径が 0 になる。
 */
export function brushEdges(input: BrushInput): BrushedEdge[] {
  const { positions, pathIndices, edgeOffsets, centerIndex, side, targetOffset, radius } = input;
  const n = Math.min(positions.length, pathIndices.length, edgeOffsets.length);
  if (centerIndex < 0 || centerIndex >= n) return [];
  const current = edgeOffsets[centerIndex][side];
  const delta = targetOffset - current;
  if (!Number.isFinite(delta) || delta === 0) return [];

  const p0 = positions[centerIndex];
  const out: BrushedEdge[] = [];
  for (let i = 0; i < n; i++) {
    const w = brushWeight(positions[i] - p0, radius);
    if (w <= 0) continue;
    const next = edgeOffsets[i][side] + delta * w;
    // 中心線をまたがせない（またぐと径が負になる）。
    const clamped = side === "left" ? Math.min(-0.25, next) : Math.max(0.25, next);
    out.push({ pathIndex: pathIndices[i], side, offset: clamped });
  }
  return out;
}

/** ブラシ半径の既定値（`positions` の単位＝校正済みなら mm）。冠動脈の径 2〜4mm に対して控えめ。 */
export const DEFAULT_BRUSH_RADIUS_MM = 1.5;
/** 未校正（px）のときの既定値。 */
export const DEFAULT_BRUSH_RADIUS_PX = 8;

/** 単位に応じた既定半径。純関数。 */
export function defaultBrushRadius(unit: "mm" | "px"): number {
  return unit === "mm" ? DEFAULT_BRUSH_RADIUS_MM : DEFAULT_BRUSH_RADIUS_PX;
}

/**
 * ブラシの結果を既存の手修正へマージする。純関数。
 *
 * <p>後から当てたブラシが勝つ（同じ点を 2 度なぞったら 2 度目が残る）。
 */
export function mergeEdgeEdits(
  current: Readonly<Record<number, { left?: number; right?: number }>>,
  brushed: readonly BrushedEdge[],
): Record<number, { left?: number; right?: number }> {
  const next: Record<number, { left?: number; right?: number }> = { ...current };
  for (const b of brushed) {
    next[b.pathIndex] = { ...next[b.pathIndex], [b.side]: b.offset };
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* 「ならす」ブラシ — 外れ点だけを動かす（2026-08-28）                    */
/* ------------------------------------------------------------------ */

/**
 * 🚨 **「押す」ブラシでは外れ点を直せない**（実機で言われた）。
 *
 * <p>押すブラシは半径内の全点へ**同じ Δ** を配る。つまり
 *
 * - 外れ点を正しい位置まで押すと、**合っていた近傍まで一緒に外れる**
 * - 近傍を合わせて押すと、**外れ点は外れたまま**（相対関係が変わらない）
 *
 * <p>直したいのが「区間ぜんぶのずれ」ではなく「1〜数点の飛び」のとき、押す操作は原理的に
 * 合わない。**ならす**（局所のロバストな当てはめへ寄せる）ほうが正しい道具になる:
 *
 * <pre>
 *   offset_i ← offset_i + (median_i − offset_i) · strength · w(距離_i)
 * </pre>
 *
 * <p>外れ点は `median_i` から遠いので大きく動き、**合っている点はほとんど動かない**。
 *
 * <h3>🔴 平均ではなく中央値</h3>
 * 平均だと**外れ点自身が目標を引っ張る**ので、外れが強いほど直りが悪くなる。
 * 中央値なら 1〜数点の飛びは当てはめに寄与しない。
 *
 * <h3>⚠️ なぞり続けると平坦化する</h3>
 * 収束先は局所中央値なので、同じ場所を何度もなでれば**本物の凹凸（＝狭窄）まで均される**。
 * だから 1 回の効きは `strength` で抑えてある。狭窄そのものを均してしまわないよう、
 * 窓は既定でブラシ半径と同じ（＝狭窄長より短い）にしている。
 */

/**
 * 弧長の窓 [pos−r, pos+r] に入る値の中央値。純関数。
 *
 * <p>窓に何も入らなければその点自身の値（＝動かさない）。
 */
export function localMedian(
  positions: readonly number[],
  values: readonly number[],
  index: number,
  windowRadius: number,
): number {
  const n = Math.min(positions.length, values.length);
  if (index < 0 || index >= n) return NaN;
  const p0 = positions[index];
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(positions[i] - p0) <= windowRadius && Number.isFinite(values[i])) win.push(values[i]);
  }
  if (win.length === 0) return values[index];
  win.sort((a, b) => a - b);
  const m = win.length >> 1;
  return win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
}

/**
 * 外れ点の検出（ロバスト）。**中央値からの隔たりを MAD で測る**。
 *
 * <p>🔴 標準偏差で測らない。外れ点そのものが散らばりを膨らませるので、**外れが大きいほど
 * 検出されにくくなる**（1 点だけ大きく飛んでいる、というまさに直したい状況で効かない）。
 *
 * <p>🚨 **MAD だけだと、いちばん直したい形を取り逃がす。** 窓の過半数が同じ値で 1 点だけ
 * 飛んでいると **MAD は 0** になり、閾値が 0 倍で誰も外れなくなる（テストで捕捉した）。
 * MAD が 0 のときは**平均絶対偏差**へ落とす——外れ 1 点でもこちらは 0 にならない。
 * どちらも 0（＝窓の中が完全に一定）なら、**本当に何も外れていない**ので何も言わない。
 *
 * @param k 閾値（MAD の何倍を外れと呼ぶか。既定 3.5 ≒ 正規分布で 2.4σ 相当）
 */
export function detectEdgeOutliers(
  positions: readonly number[],
  values: readonly number[],
  windowRadius: number,
  k = 3.5,
): number[] {
  const n = Math.min(positions.length, values.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const med = localMedian(positions, values, i, windowRadius);
    if (!Number.isFinite(med)) continue;
    // 窓内の |値 − 中央値| の中央値（MAD）。
    const p0 = positions[i];
    const dev: number[] = [];
    for (let j = 0; j < n; j++) {
      if (Math.abs(positions[j] - p0) <= windowRadius && Number.isFinite(values[j])) {
        dev.push(Math.abs(values[j] - med));
      }
    }
    if (dev.length < 5) continue; // 窓が狭すぎる＝判定できない（言わない）
    dev.sort((a, b) => a - b);
    const m = dev.length >> 1;
    const mad = dev.length % 2 ? dev[m] : (dev[m - 1] + dev[m]) / 2;
    const scale = mad > 0 ? mad : dev.reduce((a, b) => a + b, 0) / dev.length;
    if (!(scale > 0)) continue; // 窓の中が完全に一定＝本当に何も外れていない
    if (Math.abs(values[i] - med) > k * scale) out.push(i);
  }
  return out;
}

/* ── ロバストな局所当てはめ（2026-08-28・改良）───────────────────── */

/**
 * 🚨 **中央値だけでは、外れ点が「塊」になっていると直せない**（実機で言われた）。
 *
 * <p>中央値の耐性は「窓の中で外れが**半分未満**」であることが前提。自動エッジが外れるときは
 * 1 点ずつではなく**隣り合う数点がまとめて**外れることが多く、ブラシ半径と同じ幅の窓では
 * **外れの塊が多数派**になる。すると中央値そのものが外れ値になり、
 * **なでても何も動かない**（＝「ならせない」）。
 *
 * <p>対処は 3 つ重ねる:
 * <ol>
 *   <li><b>当てはめの窓をブラシ半径から切り離して広げる</b>（既定 {@link SMOOTH_WINDOW_FACTOR} 倍）。
 *       塊を多数決で負かす。</li>
 *   <li><b>定数（中央値）ではなく直線を当てる。</b> 窓を広げても血管のテーパーに追従するので、
 *       真の形を潰さない。中央値のまま窓だけ広げると**狭窄を均してしまう**。</li>
 *   <li><b>当てはめから外れ点を除く。</b> 塊が窓内で多数でも、除いてしまえば目標は正しく出る。</li>
 * </ol>
 */

/** 当てはめの窓 ＝ ブラシ半径 × これ（既定）。塊の外れを多数決で負かせる広さ。 */
export const SMOOTH_WINDOW_FACTOR = 3;

/** 当てはめに使う標本数の上限（計算量を抑える。超えたら等間隔に間引く）。 */
const FIT_SAMPLE_CAP = 41;

function median(sorted: number[]): number {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * 窓に入る点を集める。`excluded` の添字は外す。使える点が 3 未満なら、
 * **除外をやめて集め直す**（全部が外れ扱いの窓で「当てはめ不能」にしない）。
 */
function collectWindow(
  positions: readonly number[],
  values: readonly number[],
  index: number,
  windowRadius: number,
  excluded?: ReadonlySet<number>,
): { x: number[]; y: number[] } {
  const n = Math.min(positions.length, values.length);
  const p0 = positions[index];
  const pick = (skipExcluded: boolean) => {
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(positions[i] - p0) > windowRadius) continue;
      if (!Number.isFinite(values[i])) continue;
      if (skipExcluded && excluded?.has(i)) continue;
      x.push(positions[i]);
      y.push(values[i]);
    }
    return { x, y };
  };
  let w = pick(true);
  if (w.x.length < 3) w = pick(false);
  // 計算量の上限。等間隔に間引く（端は残す）。
  if (w.x.length > FIT_SAMPLE_CAP) {
    const x: number[] = [];
    const y: number[] = [];
    for (let k = 0; k < FIT_SAMPLE_CAP; k++) {
      const i = Math.round((k * (w.x.length - 1)) / (FIT_SAMPLE_CAP - 1));
      x.push(w.x[i]);
      y.push(w.y[i]);
    }
    w = { x, y };
  }
  return w;
}

/**
 * 窓の点に**ロバストな直線**を当て、`positions[index]` での値を返す。
 *
 * <p>推定は**繰り返し中央値**（Siegel）。各点について他点との傾きの中央値を取り、
 * さらにその中央値を傾きとする。**耐性 50%** で、最小二乗と違って外れ点に引かれない。
 *
 * <p>点が 2 未満なら NaN、2〜3 点なら中央値（定数）にフォールバックする
 * ——標本が足りないのに直線を当てると、**傾きが暴れて隣の点をあらぬ所へ飛ばす**。
 */
export function robustLocalLine(
  positions: readonly number[],
  values: readonly number[],
  index: number,
  windowRadius: number,
  excluded?: ReadonlySet<number>,
): number {
  const n = Math.min(positions.length, values.length);
  if (index < 0 || index >= n) return NaN;
  const { x, y } = collectWindow(positions, values, index, windowRadius, excluded);
  if (x.length === 0) return NaN;
  if (x.length < 4) return median([...y].sort((a, b) => a - b));

  const slopes: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const si: number[] = [];
    for (let j = 0; j < x.length; j++) {
      const dx = x[j] - x[i];
      if (dx === 0) continue;
      si.push((y[j] - y[i]) / dx);
    }
    if (si.length === 0) continue;
    si.sort((a, b) => a - b);
    slopes.push(median(si));
  }
  if (slopes.length === 0) return median([...y].sort((a, b) => a - b));
  slopes.sort((a, b) => a - b);
  const slope = median(slopes);
  const intercepts = x.map((xi, i) => y[i] - slope * xi).sort((a, b) => a - b);
  const intercept = median(intercepts);
  const fitted = intercept + slope * positions[index];
  return Number.isFinite(fitted) ? fitted : median([...y].sort((a, b) => a - b));
}

export interface SmoothInput {
  /** 各計測点の弧長（`QcaResult.positions`）。 */
  positions: readonly number[];
  pathIndices: readonly number[];
  edgeOffsets: readonly { left: number; right: number }[];
  /** なでている点。 */
  centerIndex: number;
  side: "left" | "right";
  /** ブラシ半径（効く範囲）。 */
  radius: number;
  /**
   * ロバスト当てはめの窓（省略時は `radius` × {@link SMOOTH_WINDOW_FACTOR}）。
   *
   * <p>🔴 **ブラシ半径と同じにしない。** 外れ点は隣り合って塊になることが多く、
   * 半径と同じ幅だと**塊が窓内の多数派**になって当てはめごと引っ張られる（＝ならせない）。
   * 直線を当てているので、広げても血管のテーパーには追従する。
   */
  windowRadius?: number;
  /** 1 回の効き（0..1・既定 {@link DEFAULT_SMOOTH_STRENGTH}）。 */
  strength?: number;
}

/** 1 回のなでで局所中央値へ寄せる割合。1.0 は一撃で均すので狭窄を潰しやすい。 */
export const DEFAULT_SMOOTH_STRENGTH = 0.6;

/** 動いたと見なす最小量（これ未満は「手修正済み」にしない）。 */
const SMOOTH_EPSILON = 1e-4;

/**
 * 「ならす」ブラシを 1 回当てた結果を返す。純関数。
 *
 * <p>半径の外と、**実質動かない点は結果に含めない**——含めると
 * 「動かしていないのに手修正済み」になり、`provenance.editedEdges` が嘘になる
 * （押すブラシと同じ規約）。符号が中心線をまたがないのも同じ。
 */
export function smoothEdges(input: SmoothInput): BrushedEdge[] {
  const { positions, pathIndices, edgeOffsets, centerIndex, side, radius } = input;
  const n = Math.min(positions.length, pathIndices.length, edgeOffsets.length);
  if (centerIndex < 0 || centerIndex >= n) return [];
  const strength = input.strength ?? DEFAULT_SMOOTH_STRENGTH;
  const windowRadius = input.windowRadius ?? radius * SMOOTH_WINDOW_FACTOR;
  if (!(strength > 0)) return [];

  const values = new Array<number>(n);
  for (let i = 0; i < n; i++) values[i] = edgeOffsets[i][side];

  // 🔴 **外れ点を当てはめから除く。** 隣り合う数点がまとめて外れていると、除かない限り
  //    当てはめごと引っ張られて「なでても動かない」になる（実機で言われた症状の本体）。
  //    検出は当てはめと同じ窓で行う（狭い窓で見ると塊が多数派になって見逃す）。
  const excluded = new Set(detectEdgeOutliers(positions, values, windowRadius));

  const p0 = positions[centerIndex];
  const out: BrushedEdge[] = [];
  for (let i = 0; i < n; i++) {
    const w = brushWeight(positions[i] - p0, radius);
    if (w <= 0) continue;
    const med = robustLocalLine(positions, values, i, windowRadius, excluded);
    if (!Number.isFinite(med)) continue;
    const change = (med - values[i]) * strength * w;
    if (Math.abs(change) < SMOOTH_EPSILON) continue;
    const next = values[i] + change;
    const clamped = side === "left" ? Math.min(-0.25, next) : Math.max(0.25, next);
    out.push({ pathIndex: pathIndices[i], side, offset: clamped });
  }
  return out;
}
