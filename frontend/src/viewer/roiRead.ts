/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI（Cornerstone annotation）を「読むだけ」の共有ヘルパ。
 *
 * <p>プラグイン host API の H5（`getRois`・fw/plugin-architecture.md §7）が使う純関数を、
 * ビューポートや Cornerstone の状態に触らない形で切り出したもの。**書き込みは一切しない**。
 *
 * <p>ここに置く最大の理由は**幾何を 1 箇所に閉じる**こと。長径・短径の算出をプラグイン側に
 * 書かせると、本体の計測値と数 mm ずれたときにどちらが正しいか誰も言えなくなる
 * （`fw/cornerstone-3d-geometry-caveat.md` と同じ趣旨。CLAUDE.md のルール 3）。
 */

/** 画素座標の点（x=列, y=行。0 始まり・サブピクセル可）。 */
export type PointPx = readonly [number, number];

/**
 * ROI 形状から得たキャリパ計測（mm）。
 *
 * <p>RECIST 1.1 の語彙に寄せてあるが、**短径の定義は「長径に直交する方向の広がり」**であって
 * 全方位の最小キャリパ幅（ImageJ の MinFeret）ではない。RECIST は短径を長径に直交して測ると
 * 規定しているため、こちらを採る。
 */
export interface RoiCaliper {
  /** 最遠 2 点間距離 (mm)。RECIST の「長径」。 */
  longAxisMm: number;
  /** 長径に直交する方向の広がり (mm)。RECIST の「短径」。 */
  shortAxisMm: number;
  /** 長径の両端（画素座標）。プラグインが確認表示に使えるよう返す。 */
  longAxisEnds: [PointPx, PointPx];
}

/**
 * 単調チェイン法による凸包（反時計回り）。
 *
 * <p>長径（最遠 2 点）と、任意方向の広がりは**どちらも凸包上で達成される**ので、
 * 先に凸包へ落としてから総当たりする。自由曲線 ROI は頂点が数千点になり得るため、
 * O(N²) の総当たりをそのまま回すと重い（かつ結果は凸包で回したものと一致する）。
 *
 * <p>共線の点は落とす（外れの極点は残るので長径・広がりに影響しない）。
 */
export function convexHull(points: ReadonlyArray<PointPx>): PointPx[] {
  const pts = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  // 重複を除く（同一点が並ぶと cross が 0 になり続けて包が崩れる）。
  const uniq: PointPx[] = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length < 3) return uniq;

  const cross = (o: PointPx, a: PointPx, b: PointPx): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (src: PointPx[]): PointPx[] => {
    const out: PointPx[] = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = build(uniq);
  const upper = build(uniq.slice().reverse());
  // 各鎖の終点は他方の始点と重複するので落とす。
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * 頂点集合が「形状の輪郭（または単一線分）」を表すツール名（小文字）。
 *
 * <p>**許可リストにしてある**（除外リストではない）。理由は 2 つ:
 * ① 部分一致の除外は取り違える — `RectangleROI` は `angle` を含む（Rect**angle**ROI）ので、
 *    除外正規表現に `angle` を入れると矩形 ROI が黙って計測不能になる（実際にこれを踏んだ）。
 * ② 知らないツールに対しては**値を出さない**方が安全。数値が出ないのは気付けるが、
 *    意味の違う数値が出るのは気付けない。新しい面 ROI ツールを足したらここに追記する。
 */
const OUTLINE_TOOLS = new Set([
  "length",
  "ellipticalroi",
  "rectangleroi",
  "circleroi",
  "planarfreehandroi",
  "splineroi",
  "livewirecontour",
  "rectangleroithreshold",
]);

/**
 * そのツールの頂点集合に対して、長径・短径（キャリパ）を**意味づけられるか**。純関数。
 *
 * <p>意味を持つのは「形状の輪郭」を表す頂点（楕円・矩形・円・自由曲線・スプライン）と、
 * 単一線分（Length）。主な除外:
 * - **Bidirectional**: ユーザーが引いた 2 軸そのものが計測値なので、形状から出し直す意味が無い。
 *   しかも交差する 2 線分なので、短軸を長軸の**端に寄せて**引くと
 *   `sqrt(p² + (S/2)²) > L`（p→L）となり、ハンドル間の最遠距離が**ユーザーの長軸を超える**。
 *   このツールでは `length` / `shortAxis` だけが正しい。
 * - **Angle / CobbAngle**: 折れ線。頂点間の最遠距離に形状としての意味が無い。
 * - **Probe**: 1 点。**ArrowAnnotate**: 計測ではなく注記。
 */
export function hasShapeCalipers(tool: string): boolean {
  return OUTLINE_TOOLS.has(tool.trim().toLowerCase());
}

/**
 * ROI 形状のキャリパ計測。**画素座標＋画素間隔から mm 空間で計算する**（異方性画素に対応）。
 *
 * <p>アルゴリズムは GRAPHY(Java) の `RecistCalculator` と同一:
 * ①頂点を mm 空間へ写す ②最遠 2 点＝長径 ③長径の角度だけ逆回転して直交方向の広がり＝短径。
 * ただし総当たりの前に凸包へ落としてある（結果は同じ・計算量が下がる）。
 *
 * <p>**画素間隔が不明なら null を返す**（mm を捏造しない）。有効な点が 2 点未満でも null。
 *
 * @param pointsPx 頂点（画素座標）
 * @param spacingX 列方向(x)の画素間隔 mm
 * @param spacingY 行方向(y)の画素間隔 mm
 */
export function computeCalipers(
  pointsPx: ReadonlyArray<PointPx>,
  spacingX: number | null | undefined,
  spacingY: number | null | undefined,
): RoiCaliper | null {
  if (!Number.isFinite(spacingX) || !Number.isFinite(spacingY)) return null;
  const sx = spacingX as number;
  const sy = spacingY as number;
  if (!(sx > 0) || !(sy > 0)) return null;

  const hull = convexHull(pointsPx);
  if (hull.length < 2) return null;

  // mm 空間の対応点（index は hull と揃える）。
  const mm = hull.map((p) => [p[0] * sx, p[1] * sy] as [number, number]);

  let maxSq = -1;
  let i1 = -1;
  let i2 = -1;
  for (let i = 0; i < mm.length; i++) {
    for (let j = i + 1; j < mm.length; j++) {
      const dx = mm[j][0] - mm[i][0];
      const dy = mm[j][1] - mm[i][1];
      const d2 = dx * dx + dy * dy;
      if (d2 > maxSq) {
        maxSq = d2;
        i1 = i;
        i2 = j;
      }
    }
  }
  if (i1 < 0 || !(maxSq > 0)) return null;

  const longAxisMm = Math.sqrt(maxSq);
  // 長径方向の単位ベクトル。直交成分の広がりを内積で直接取る（回転行列を組まなくてよい）。
  const ux = (mm[i2][0] - mm[i1][0]) / longAxisMm;
  const uy = (mm[i2][1] - mm[i1][1]) / longAxisMm;
  let minPerp = Infinity;
  let maxPerp = -Infinity;
  for (const p of mm) {
    // 長径に直交する軸への射影（法線 (-uy, ux) との内積）。
    const perp = -uy * p[0] + ux * p[1];
    if (perp < minPerp) minPerp = perp;
    if (perp > maxPerp) maxPerp = perp;
  }

  return {
    longAxisMm,
    shortAxisMm: maxPerp - minPerp,
    longAxisEnds: [hull[i1], hull[i2]],
  };
}

/**
 * 2 点間距離 (mm)。Length / Bidirectional のツール値を本体側で検算するのに使う。
 * 画素間隔が不明なら null。
 */
export function distanceMm(
  a: PointPx,
  b: PointPx,
  spacingX: number | null | undefined,
  spacingY: number | null | undefined,
): number | null {
  if (!Number.isFinite(spacingX) || !Number.isFinite(spacingY)) return null;
  const sx = spacingX as number;
  const sy = spacingY as number;
  if (!(sx > 0) || !(sy > 0)) return null;
  const dx = (b[0] - a[0]) * sx;
  const dy = (b[1] - a[1]) * sy;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * ROI に紐付くプラグイン属性のキー接頭辞。
 *
 * <p>プラグインが渡すキーは**必ずこの名前空間に入れる**（前置は host が行い、プラグインには
 * 選ばせない）。こうしておくと、プラグインは本体のキーや他プラグインのキーを読めず・踏めない。
 * GRAPHY(Java) が ROI プロパティを `lesionevanesco.*` で分けていたのと同じ発想。
 */
export function pluginMetaPrefix(pluginId: string): string {
  return `plugin.${pluginId}.`;
}

/**
 * `roiMaskStore` の `custom` から、そのプラグインの属性だけを接頭辞を剥がして取り出す。純関数。
 * 他プラグインのキー・本体のキーは**出てこない**。
 */
export function pickPluginMeta(
  custom: Record<string, string> | undefined,
  pluginId: string,
): Record<string, string> {
  if (!custom) return {};
  const prefix = pluginMetaPrefix(pluginId);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(custom)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/**
 * プラグインが渡した patch を、保存用の（接頭辞付き）`custom` パッチへ変換する。純関数。
 * 値は文字列化する（プラグインは JS なので数値や boolean を渡してくる）。
 */
export function buildPluginMeta(pluginId: string, patch: Record<string, string> | undefined): Record<string, string> {
  const prefix = pluginMetaPrefix(pluginId);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch ?? {})) out[`${prefix}${k}`] = String(v);
  return out;
}

/** Cornerstone の cachedStats 1 件（読める項目だけ拾う）。 */
export interface RoiStats {
  length?: number;
  /** Bidirectional の短軸（Cornerstone は `width` という名前で持つ）。 */
  width?: number;
  area?: number;
  mean?: number;
  stdDev?: number;
  min?: number;
  max?: number;
  /**
   * 統計値（mean/stdDev/min/max）の単位。**`modalityUnit` のみ**を見る（CT なら "HU"）。
   *
   * <p>Cornerstone の `unit` は**長さの単位**（"mm" / "px"）なのでここには混ぜない。
   * 混ぜると「統計の単位が mm」という無意味な値がプラグインへ流れる（実機で踏んだ）。
   */
  unit?: string;
  /**
   * `length` / `width` の単位（Cornerstone の `unit`）。**画素間隔が無いシリーズでは "px"** になる。
   * mm として扱ってよいのは "mm" のときだけ。
   */
  lengthUnit?: string;
  areaUnit?: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * `annotation.data.cachedStats` から統計を拾う。純関数（テスト対象）。
 *
 * <p>cachedStats は `imageId:…` をキーにした辞書で、**その ROI がまだ描画されていないと空**
 * （Cornerstone は描画時に計算する）。取れない項目は `undefined` のままにし、0 で埋めない
 * ＝「測っていない」と「0 だった」を区別する。
 *
 * @param cachedStats annotation.data.cachedStats
 * @param preferKeyIncludes この文字列を含むキーを優先（通常は対象 imageId）
 */
export function readRoiStats(cachedStats: unknown, preferKeyIncludes?: string): RoiStats {
  const dict = cachedStats as Record<string, unknown> | undefined | null;
  if (!dict || typeof dict !== "object") return {};
  const keys = Object.keys(dict);
  if (!keys.length) return {};
  const key =
    (preferKeyIncludes && keys.find((k) => k.includes(preferKeyIncludes))) ??
    // 中身のあるものを選ぶ（別スライスの空エントリを掴まないため）。
    keys.find((k) => {
      const e = dict[k] as Record<string, unknown> | undefined;
      return e && (num(e.length) !== undefined || num(e.area) !== undefined || num(e.mean) !== undefined);
    }) ??
    keys[0];
  const e = dict[key] as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object") return {};
  return {
    length: num(e.length),
    width: num(e.width),
    area: num(e.area),
    mean: num(e.mean),
    stdDev: num(e.stdDev),
    min: num(e.min),
    max: num(e.max),
    unit: str(e.modalityUnit),
    lengthUnit: str(e.unit),
    areaUnit: str(e.areaUnit),
  };
}
