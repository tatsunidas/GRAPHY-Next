/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QLV（左室造影の定量解析）— `fw/angio-design.md` §9.2 / A5b。
 *
 * <h3>入力の約束</h3>
 * 輪郭は **大動脈弁輪の一端 → 心尖 → 他端** の順に並んだ開いた点列で受け取る。
 * 閉じるのは「最初の点と最後の点を結ぶ弦（＝弁面）」で、この規約から:
 * - **弁面** = 最初の点と最後の点を結ぶ線分
 * - **長軸長 L** = 弁面の中点から最も遠い輪郭点（＝心尖）までの距離
 * が一意に決まる。長軸を別途引かせない（道具を増やさない。§8.5 と同じ方針）。
 *
 * <h3>🚨 未校正でも EF は出せる（が、補正を入れると出せなくなる）</h3>
 * 体積は長さの 3 乗に比例するので、未知の倍率 k は EF = 1 − ESV/EDV で**完全に打ち消される**。
 * よって空間校正が無くても EF は正しい（§9.2.1）。
 * ただし **Kennedy の回帰補正 `V = 0.928·V_AL − 3.8 mL` は定数項を持つアフィン変換**で、
 * スケール不変ではない。**未校正で補正版を出すと嘘になる**ので、
 * {@link kennedyCorrectedMl} は mL が確定しているときしか呼んではいけない。
 *
 * <h3>🚨 Area-Length は「左室は回転楕円体」という仮定そのもの</h3>
 * V = 8A²/(3πL) は長球（prolate spheroid）の厳密解である。したがって**楕円体で検証すると
 * 必ず真値が出る**（それは式を検算しているだけで、手法の誤差を測っていない）。
 * 精度検証は非楕円体のファントムで行うこと（§16.3 の GNBP-XA-5 の警告）。
 */

export type Point = readonly [number, number];

/** 画素の物理サイズ。null なら未校正（px のまま扱う）。 */
export interface PixelSize {
  mmPerPxRow: number | null;
  mmPerPxCol: number | null;
}

export interface LvFrameMetrics {
  /** 投影面積 [px²]。 */
  areaPx2: number;
  /** 投影面積 [mm²]。未校正なら null。 */
  areaMm2: number | null;
  /** 長軸長 [px]。 */
  longAxisPx: number;
  /** 長軸長 [mm]。未校正なら null。 */
  longAxisMm: number | null;
  /** Area-Length 容積 [mL]。**未校正なら null**（px³ を mL と偽らない）。 */
  volumeMl: number | null;
  /** 未校正でも比較できるよう px 空間のまま計算した容積 [px³]。 */
  volumePx3: number;
  /** 心尖と判定した輪郭点の添字。 */
  apexIndex: number;
  /** 弁面の中点 [px]。 */
  valveMid: Point;
  /** 弁面の長さ [px]（弁輪径。極端に大きい/小さいと輪郭の引き方を疑う材料になる）。 */
  valveWidthPx: number;
}

/** 多角形の面積（符号なし）。輪郭は弁面の弦で閉じる。 */
export function polygonArea(points: readonly Point[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** 輪郭の重心（多角形の図心。頂点の平均ではない）。 */
export function polygonCentroid(points: readonly Point[]): Point {
  const n = points.length;
  if (n === 0) return [0, 0];
  if (n < 3) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / n, sy / n];
  }
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const cross = p[0] * q[1] - q[0] * p[1];
    a2 += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a2) < 1e-12) return points[0];
  return [cx / (3 * a2), cy / (3 * a2)];
}

/**
 * 1 フレームぶんの計測。
 *
 * @param contour 弁輪の一端 → 心尖 → 他端 の順の点列（画像 px）
 */
export function lvMetrics(contour: readonly Point[], px: PixelSize): LvFrameMetrics | null {
  if (contour.length < 4) return null;
  const first = contour[0];
  const last = contour[contour.length - 1];
  const valveMid: Point = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];

  // 心尖 ＝ 弁面の中点から最も遠い輪郭点。臨床の定義そのままで、別入力が要らない。
  let apexIndex = 0;
  let longAxisPx = -1;
  for (let i = 0; i < contour.length; i++) {
    const d = Math.hypot(contour[i][0] - valveMid[0], contour[i][1] - valveMid[1]);
    if (d > longAxisPx) {
      longAxisPx = d;
      apexIndex = i;
    }
  }
  if (!(longAxisPx > 0)) return null;

  const areaPx2 = polygonArea(contour);
  if (!(areaPx2 > 0)) return null;

  // px 空間の容積（未校正でも EF を出すため。単位は px³ で、mL とは絶対に呼ばない）。
  const volumePx3 = (8 * areaPx2 * areaPx2) / (3 * Math.PI * longAxisPx);

  const row = px.mmPerPxRow;
  const col = px.mmPerPxCol;
  let areaMm2: number | null = null;
  let longAxisMm: number | null = null;
  let volumeMl: number | null = null;
  if (row && col && row > 0 && col > 0) {
    // ⚠️ 非等方をそのまま扱う。行・列で mm/px が違う場合、面積は積、長さは方向で違う。
    areaMm2 = areaPx2 * row * col;
    const dx = (contour[apexIndex][0] - valveMid[0]) * col;
    const dy = (contour[apexIndex][1] - valveMid[1]) * row;
    longAxisMm = Math.hypot(dx, dy);
    if (longAxisMm > 0) {
      const mm3 = (8 * areaMm2 * areaMm2) / (3 * Math.PI * longAxisMm);
      volumeMl = mm3 / 1000;
    }
  }

  return {
    areaPx2,
    areaMm2,
    longAxisPx,
    longAxisMm,
    volumeMl,
    volumePx3,
    apexIndex,
    valveMid,
    valveWidthPx: Math.hypot(last[0] - first[0], last[1] - first[1]),
  };
}

/** 駆出率 [%]。**スケール不変**（体積 ∝ 長さ³ なので倍率が比で消える）。 */
export function ejectionFraction(edv: number, esv: number): number {
  if (!(edv > 0)) return NaN;
  return ((edv - esv) / edv) * 100;
}

/**
 * Kennedy の回帰補正 [mL]。
 *
 * <p>🚨 **定数項があるのでスケール不変ではない。** 校正が確定して mL が出せるときにだけ使う。
 * 未校正の px³ に当てると、係数どころか意味の無い値になる。
 */
export function kennedyCorrectedMl(volumeMl: number): number {
  return 0.928 * volumeMl - 3.8;
}

export interface EdEsSuggestion {
  /** 拡張末期フレーム（0 origin）。 */
  ed: number;
  /** 収縮末期フレーム（0 origin）。**ED より後**を優先する。 */
  es: number;
  /** 探索に使った区間 [from, to]（造影が定常になって以降）。 */
  window: [number, number];
  warnings: EdEsWarning[];
}

export type EdEsWarning =
  /** 1 フレーム目から満量で、造影の立ち上がりが観測できていない（前の注入が残っている疑い）。 */
  | "fillingNotDetected"
  /** ED より後に極小が無く、全区間の極小を採った（心周期をまたげていない）。 */
  | "esBeforeEd"
  /** 探索区間が短く、心周期が 1 つ分入っていない可能性がある。 */
  | "shortWindow"
  /**
   * ED → ES の間隔が生理的にありえない（収縮期はおよそ 200〜500 ms）。
   * **面積の指標が心室の大きさを反映していない**ことのほうが疑わしい。
   */
  | "implausibleInterval"
  /**
   * 心周期のさざ波を拾えず、素朴な最大・最小に退避した。
   * **指標が心室の大きさを見ていない**疑いが強い（画面全体を数えている等）。
   */
  | "noCardiacRipple";

/**
 * 造影された面積の時系列から ED / ES フレームを提案する。
 *
 * <p>⚠️ **これは提案であって決定ではない。** 造影剤注入で心室期外収縮（PVC）は普通に起き、
 * その直後の心拍は代償性に大きく駆出するので EF を過大評価する。ECG が無い本経路では
 * PVC を検出できないので、**必ず人が選び直せること**を UI の要件とする（§9.2.2）。
 *
 * @param areas フレームごとの「造影された面積」に相当する量（単調な指標なら何でもよい）
 * @param opts.frameIntervalMs `areas` の 1 要素あたりの時間 [ms]。渡すと ED→ES の間隔が
 *        生理的に妥当かを検査する。**これが効くのは指標が心室を見ているときだけ**で、
 *        画面全体の暗い画素を数えているような弱い指標では、この警告が出ることで
 *        「指標が心室を反映していない」ことに気づける
 */
export function suggestEdEs(
  areas: readonly number[],
  opts?: { frameIntervalMs?: number | null },
): EdEsSuggestion | null {
  const n = areas.length;
  if (n < 3) return null;
  const warnings: EdEsWarning[] = [];

  let min = Infinity;
  let max = -Infinity;
  for (const v of areas) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return null;

  const dt = opts?.frameIntervalMs && opts.frameIntervalMs > 0 ? opts.frameIntervalMs : null;

  // ── ① トレンド（造影の充満）を引く ────────────────────────────
  //
  // 🚨 **生の曲線の最大＝ED、ではない**（実機で踏んだ・2026-09-02）。造影は注入のあいだ
  //    増え続けるので曲線に**強い上り坂**が乗り、心周期のさざ波がその上に載る。素朴に
  //    全体の最大を採ると**末尾のフレーム**が ED になり、「ES は ED より後」の制約で
  //    ES が隣に押し出される。実データ（Rubo 0009）では **ED 132 / ES 135・間隔 120ms・
  //    面積比 0.977**——ほぼ同じ位相の 2 枚で、収縮をまったく捉えていなかった。
  //
  //    そこで**移動中央値でトレンドを推定して引き**、残ったさざ波（＝心周期）から選ぶ。
  //    中央値にするのは、平均だと山と谷そのものに引きずられるため。
  const detr = detrend(areas, trendWindow(n, dt));

  // ── ② さざ波の山と谷 ────────────────────────────────────
  const peaks: number[] = [];
  const troughs: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (detr[i] >= detr[i - 1] && detr[i] > detr[i + 1]) peaks.push(i);
    if (detr[i] <= detr[i - 1] && detr[i] < detr[i + 1]) troughs.push(i);
  }

  // ── ③ 「山 → その直後の谷」を組にして、妥当なものを選ぶ ──────────
  //
  // 🔴 選ぶ基準は**生の面積の落差が最大**の組。落差が大きい＝よく造影された心拍で、
  //    収縮を最もはっきり捉えている。トレンド除去後の値で比べると、坂の傾きの差が残る。
  const minFill = min + (max - min) * 0.85;
  let best: { ed: number; es: number; drop: number } | null = null;
  for (const p of peaks) {
    // 十分に造影された心拍だけを見る（充満途中の心拍は心室サイズを過小評価する）。
    if (areas[p] < minFill) continue;
    const t = troughs.find((x) => x > p);
    if (t === undefined) continue;
    if (!plausibleSystole(t - p, n, dt)) continue;
    const drop = areas[p] - areas[t];
    if (drop <= 0) continue;
    if (!best || drop > best.drop) best = { ed: p, es: t, drop };
  }

  if (best) {
    if (peaks.length < 2) warnings.push("shortWindow");
    return { ed: best.ed, es: best.es, window: [0, n - 1], warnings };
  }

  // ── ④ さざ波が拾えなかったときの退避 ───────────────────────
  //
  // ⚠️ ここへ来るのは「指標が心室を見ていない」場合が多い（画面全体の暗い画素を数えている等）。
  //    無理に良い組を作らず、**素朴な最大・最小を返したうえで警告を残す**。
  warnings.push("noCardiacRipple");
  const target = min + (max - min) * 0.95;
  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (areas[i] >= target) {
      filled = i;
      break;
    }
  }
  const from = filled;
  if (filled === 0) warnings.push("fillingNotDetected");
  const to = n - 1;
  if (to - from < 3) warnings.push("shortWindow");

  let ed = from;
  for (let i = from; i <= to; i++) if (areas[i] > areas[ed]) ed = i;
  let es = -1;
  for (let i = ed + 1; i <= to; i++) if (es < 0 || areas[i] < areas[es]) es = i;
  if (es < 0 || es === ed) {
    warnings.push("esBeforeEd");
    es = from;
    for (let i = 0; i <= to; i++) if (areas[i] < areas[es]) es = i;
  }
  if (dt) {
    const gapMs = Math.abs(es - ed) * dt;
    if (gapMs < 120 || gapMs > 900) warnings.push("implausibleInterval");
  }
  return { ed, es, window: [from, to], warnings };
}

/** トレンドを均す窓幅（要素数・奇数）。心拍 1 つ強（約 1.2 秒）を目安にする。 */
function trendWindow(n: number, frameIntervalMs: number | null): number {
  const w = frameIntervalMs ? Math.round(1200 / frameIntervalMs) : Math.round(n / 6);
  return Math.max(3, w | 1);
}

/** 移動中央値を引く。**平均ではなく中央値**——平均は山と谷に引きずられる。 */
function detrend(areas: readonly number[], window: number): number[] {
  const n = areas.length;
  const half = window >> 1;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const w = areas.slice(lo, hi + 1).sort((a, b) => a - b);
    const m = w.length >> 1;
    out[i] = w.length % 2 ? w[m] : (w[m - 1] + w[m]) / 2;
  }
  for (let i = 0; i < n; i++) out[i] = areas[i] - out[i];
  return out;
}

/**
 * ED → ES の隔たりが収縮期として妥当か。
 *
 * <p>時間が分かるなら **150〜600 ms**（収縮期はおよそ 200〜500ms。端は少し緩める）。
 * 分からないときは要素数で見るしかないので、**1 心拍を全体の 1/6 と仮定**した緩い窓にする。
 */
function plausibleSystole(gap: number, n: number, frameIntervalMs: number | null): boolean {
  if (gap <= 0) return false;
  if (frameIntervalMs) {
    const ms = gap * frameIntervalMs;
    return ms >= 150 && ms <= 600;
  }
  return gap >= 1 && gap <= Math.max(2, Math.round(n / 6));
}

/**
 * 矩形の中だけで造影画素を数える。
 *
 * <p>🚨 **画面全体で数えると、心室ではなく画像全体の明るさを測ってしまう。** 実データ
 * （Rubo `0009.DCM`）で試したところ、横隔膜・脊椎・カテーテル・大動脈が効いてしまい、
 * ED/ES として**3 フレームしか離れていない**組（＝心周期になっていない）が提案された。
 * 左室のあたりに矩形を切って初めて、曲線が心室の拡張・収縮を表す。
 */
export function opacifiedAreaInRect(
  values: Float32Array | readonly number[],
  width: number,
  height: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  threshold = 0.5,
): number {
  const x0 = Math.max(0, Math.floor(rect.x0));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const x1 = Math.min(width - 1, Math.ceil(rect.x1));
  const y1 = Math.min(height - 1, Math.ceil(rect.y1));
  if (x1 <= x0 || y1 <= y0) return 0;
  const sub: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) sub.push(values[y * width + x]);
  }
  return opacifiedAreaCount(sub, threshold);
}

/** 点列の外接矩形を `margin` 割だけ広げる（輪郭から関心領域を作る）。 */
export function expandedBounds(
  points: readonly Point[],
  margin = 0.2,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (points.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const mx = (x1 - x0) * margin;
  const my = (y1 - y0) * margin;
  return { x0: x0 - mx, y0: y0 - my, x1: x1 + mx, y1: y1 + my };
}

/**
 * 輪郭を弧長で等分に再標本化する（開いた曲線として扱う）。
 * 壁運動の対応付けに使う。
 */
export function resampleByArcLength(points: readonly Point[], count: number): Point[] {
  if (points.length < 2 || count < 2) return [...points];
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return [...points];
  const out: Point[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (seg < cum.length - 1 && cum[seg] < target) seg++;
    const t0 = cum[seg - 1];
    const t1 = cum[seg];
    const u = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
    const a = points[seg - 1];
    const b = points[seg];
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

export interface WallMotionResult {
  /** 各弦の短縮量。内向きが正。単位は入力と同じ（px）。 */
  shortening: number[];
  /**
   * 無次元化した短縮量（`shortening / √(ED 面積)`）。
   * **スケール不変**なので未校正でも比較できる。
   */
  normalized: number[];
  /** 弦の始点（ED 輪郭上）。描画用。 */
  edPoints: Point[];
  /** 弦の終点（ES 輪郭上）。描画用。 */
  esPoints: Point[];
  /**
   * 実装した手法の名前。
   *
   * <p>⚠️ **Sheehan の centerline 法ではない。** あちらは 2 つの輪郭の中間に中心線を構成し、
   * それに直交する弦を取る。ここは**弧長による対応付けで弦を張る**簡便法で、
   * 心尖付近など曲率が大きい所では対応がずれる。名前を借りない（§9.2.3）。
   */
  method: "arc-length-chords";
}

/**
 * 壁運動（弦の短縮）。ED と ES の輪郭を弧長で対応付け、対応点間の距離を短縮量とする。
 *
 * <p>符号は「ES 点が ED 輪郭の図心へ近づく向き」を正にする。**動いていない壁は 0 付近**、
 * 奇異性運動（外向き）は負になる。
 */
export function wallMotion(ed: readonly Point[], es: readonly Point[], count = 100): WallMotionResult | null {
  if (ed.length < 3 || es.length < 3) return null;
  const a = resampleByArcLength(ed, count);
  const b = resampleByArcLength(es, count);
  const c = polygonCentroid(ed);
  const areaEd = polygonArea(ed);
  const scale = areaEd > 0 ? Math.sqrt(areaEd) : 1;
  const shortening: number[] = [];
  const normalized: number[] = [];
  for (let i = 0; i < count; i++) {
    const dx = b[i][0] - a[i][0];
    const dy = b[i][1] - a[i][1];
    const d = Math.hypot(dx, dy);
    // 図心へ向かうベクトルとの内積で向きを決める。
    const ix = c[0] - a[i][0];
    const iy = c[1] - a[i][1];
    const inward = dx * ix + dy * iy;
    const signed = inward >= 0 ? d : -d;
    shortening.push(signed);
    normalized.push(signed / scale);
  }
  return { shortening, normalized, edPoints: a, esPoints: b, method: "arc-length-chords" };
}

export interface QlvResult {
  edFrame: number;
  esFrame: number;
  ed: LvFrameMetrics;
  es: LvFrameMetrics;
  /** 駆出率 [%]。**校正の有無によらず正しい**（§9.2.1）。 */
  ejectionFraction: number;
  /** EDV [mL]。未校正なら null。 */
  edvMl: number | null;
  /** ESV [mL]。未校正なら null。 */
  esvMl: number | null;
  /** Kennedy 補正後の EDV/ESV/EF。**未校正なら null**（アフィンなのでスケール不変でない）。 */
  kennedy: { edvMl: number; esvMl: number; ejectionFraction: number } | null;
  wallMotion: WallMotionResult | null;
  unit: "mL" | "px³";
  warnings: QlvWarning[];
}

export type QlvWarning =
  /** 未校正。容積は出さず EF だけを出している。 */
  | "uncalibrated"
  /** ES の容積が ED を上回った（輪郭かフレーム選択の誤り）。 */
  | "esLargerThanEd"
  /** Kennedy 補正後の容積が負になった（小さすぎる心室 or 校正の誤り）。 */
  | "kennedyNegative"
  /** ED と ES で弁輪径が大きく違う（同じ弁面を指していない疑い）。 */
  | "valveWidthMismatch";

/** ED / ES の輪郭から最終結果を組み立てる。 */
export function computeQlv(input: {
  edFrame: number;
  esFrame: number;
  edContour: readonly Point[];
  esContour: readonly Point[];
  pixel: PixelSize;
  chordCount?: number;
}): QlvResult | null {
  const ed = lvMetrics(input.edContour, input.pixel);
  const es = lvMetrics(input.esContour, input.pixel);
  if (!ed || !es) return null;

  const calibrated = ed.volumeMl != null && es.volumeMl != null;
  // 未校正なら px³ で比を取る。EF はスケール不変なのでどちらで計算しても同じ。
  const edv = calibrated ? (ed.volumeMl as number) : ed.volumePx3;
  const esv = calibrated ? (es.volumeMl as number) : es.volumePx3;
  const ef = ejectionFraction(edv, esv);

  const warnings: QlvWarning[] = [];
  if (!calibrated) warnings.push("uncalibrated");
  if (esv >= edv) warnings.push("esLargerThanEd");
  const wRatio = ed.valveWidthPx > 0 ? es.valveWidthPx / ed.valveWidthPx : 1;
  if (wRatio > 1.5 || wRatio < 1 / 1.5) warnings.push("valveWidthMismatch");

  let kennedy: QlvResult["kennedy"] = null;
  if (calibrated) {
    const kEdv = kennedyCorrectedMl(ed.volumeMl as number);
    const kEsv = kennedyCorrectedMl(es.volumeMl as number);
    if (kEdv <= 0 || kEsv < 0) {
      warnings.push("kennedyNegative");
    } else {
      kennedy = { edvMl: kEdv, esvMl: kEsv, ejectionFraction: ejectionFraction(kEdv, kEsv) };
    }
  }

  return {
    edFrame: input.edFrame,
    esFrame: input.esFrame,
    ed,
    es,
    ejectionFraction: ef,
    edvMl: ed.volumeMl,
    esvMl: es.volumeMl,
    kennedy,
    wallMotion: wallMotion(input.edContour, input.esContour, input.chordCount ?? 100),
    unit: calibrated ? "mL" : "px³",
    warnings,
  };
}

/**
 * 閉曲線ではなく**開いた輪郭**を Catmull-Rom で滑らかにする（クリック点の間を補間）。
 * 端点は複製して外挿しない（弁面の位置を勝手に動かさないため）。
 */
export function smoothContour(points: readonly Point[], perSegment = 8): Point[] {
  const n = points.length;
  if (n < 3 || perSegment < 2) return [...points];
  const at = (i: number): Point => points[Math.max(0, Math.min(n - 1, i))];
  const out: Point[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  out.push(points[n - 1]);
  return out;
}

/**
 * フレームごとの「造影された面積」を数える（ED/ES の提案に使う）。
 *
 * <p>閾値は**そのフレームの中の相対値**にする。造影の濃さ・X 線量はフレームで変わるので、
 * 固定閾値だと造影の濃淡を心室サイズの変化として拾う。
 *
 * @param values 関心領域内の画素値（血管・心室が**暗い**前提。DSA 後なら反転して渡す）
 */
export function opacifiedAreaCount(values: Float32Array | readonly number[], threshold = 0.5): number {
  const n = values.length;
  if (n === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return 0;
  const cut = min + (max - min) * threshold;
  let count = 0;
  for (let i = 0; i < n; i++) if (values[i] <= cut) count++;
  return count;
}

/**
 * 入力されたフレーム番号を、実際に指せる添字へ丸める。指せなければ null。
 *
 * <h3>🚨 なぜ関数にしてあるか（実機で踏んだ・2026-09-02）</h3>
 * 呼び出し側は素朴にこう書いていた:
 *
 * <pre>const v = Math.max(0, Math.min(frameCount - 1, Math.round(value)));</pre>
 *
 * これは **NaN を素通しする**。`Math.round(NaN)` も `Math.min(x, NaN)` も
 * `Math.max(0, NaN)` もすべて NaN なので、**丸めているつもりで何も丸まっていない**。
 * ED/ES の入力欄に数字にならない文字（`-` や `1e` の途中）を打つと `Number()` が NaN を返し、
 * それがそのまま状態に入って:
 *
 * <ul>
 *   <li>面積カーブの縦線が `x1="NaN"` になり **SVG がエラーを吐く**</li>
 *   <li>`onGoToFrame(NaN)` で**ビューアの表示フレーム番号まで NaN** になる（こちらが本体の害）</li>
 * </ul>
 *
 * <p>🔴 **空文字は「0 フレーム目」ではない。** `Number("")` は 0 なので、素通しすると
 * 入力欄を消しただけで**先頭フレームへ飛び、その位相の輪郭が破棄される**。
 * 「消して打ち直す」という普通の操作でデータが消えるので、空は**変更なし**として扱う。
 */
export function clampFrameIndex(value: unknown, frameCount: number): number | null {
  if (!Number.isInteger(frameCount) || frameCount <= 0) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(frameCount - 1, Math.round(n)));
}
