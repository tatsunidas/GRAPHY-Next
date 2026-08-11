/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI（幾何注釈）の永続化フォーマットと、Cornerstone annotation との相互変換（純関数）。
 *
 * <p>設計は `fw/roi-manager-design.md` の M5（アプリ内 JSON）。**このファイルがスキーマの正本**で、
 * backend（`/api/rois/{patientKey}`）は中身を解釈せず保管と版管理だけを行う。
 *
 * <p><b>なぜ `referencedImageId` を保存しないか</b>: imageId は `wadouri:http://localhost:<port>/...`
 * の形で、standalone の backend ポートは起動ごとに変わる。保存すると次回の復元で 1 件も一致しない。
 * 代わりに **SOP Instance UID** を鍵にし、復元時に表示中スタックの imageId へ解決する。
 *
 * <p><b>なぜ world 座標をそのまま保存するか</b>: annotation の権威データは患者座標(LPS mm)の
 * ハンドル座標で、これは IPP/IOP から決まるので **SOP インスタンスが同じなら再起動後も同じ値**。
 * 画素座標へ落として保存すると往復で丸め誤差が入り、計測値が変わってしまう
 * （`fw/cornerstone-3d-geometry-caveat.md` と同じ「確定値は 1 つの幾何で完結させる」方針）。
 */
import type { DimScope, RoiScope } from "./roiMaskStore";

/** 保存フォーマットの版。互換性を壊す変更をしたら上げ、読み込み側で分岐する。 */
export const ROI_SCHEMA_VERSION = 1;

/** 保存する ROI 1 件。 */
export interface SavedRoi {
  /** Cornerstone の annotationUID。**同じ UID で読み戻す**（プラグインが鍵に使えるようにする）。 */
  roiUid: string;
  /** ツール名（"Length" / "Bidirectional" / "EllipticalROI" / …）。 */
  tool: string;
  /** この ROI が乗っている DICOM インスタンス。復元時に imageId へ解決する鍵。 */
  sopInstanceUid: string;
  studyUid?: string;
  seriesUid?: string;
  /** ZCT（復元先スタックの特定と scope 復元に使う）。 */
  c?: number;
  t?: number;
  /** ハンドル座標（患者座標 LPS mm）。 */
  points: number[][];
  /** 輪郭系ツールの polyline（患者座標 LPS mm）。無いツールでは省略。 */
  polyline?: number[][];
  /** 開いた輪郭か（PlanarFreehandROI 等）。 */
  isOpenContour?: boolean;
  /**
   * スプライン系ツールの補間方法（`"LINEAR"` / `"CATMULLROM"` 等）。
   *
   * <p>**ROI ごとに持たないと復元でカクカクに戻る**: 補間方法はツール側の設定から作られるため、
   * 保存しないと「スプライン Fit を切った状態で読み直したら曲線が直線になる」ことになる。
   */
  splineType?: string;
  /** ROI マネージャのメタ（ラベル・説明・scope・プラグイン属性）。 */
  label?: string;
  description?: string;
  scope?: RoiScope;
  origin?: RoiScope;
  custom?: Record<string, string>;
  isVisible?: boolean;
  isLocked?: boolean;
}

/**
 * 削除の記録（墓標）。
 *
 * <p><b>なぜ必要か</b>: 同じ患者を別ウィンドウ（＝別レンダラ＝別 annotation state）で開いていると、
 * 片方は相手の ROI を知らない。単純に和を取ると**片方で削除した ROI が相手の保存で復活する**。
 * RECIST では「消したはずの病変が戻る」は判定を誤らせるので、削除も記録して伝播させる。
 *
 * <p><b>なぜ時刻比較が要らないか</b>: Cornerstone の `annotationUID` は uuid で**再利用されない**
 * （削除後に同じ場所を描き直しても別 UID になる）。よって墓標に載った UID は無条件に落としてよい。
 * `at` は世代管理（古い墓標の刈り取り）と監査のためだけに持つ。
 */
export interface RoiTombstone {
  roiUid: string;
  /** 削除時刻（ISO-8601）。 */
  at: string;
}

/** backend に保存する本体。 */
export interface RoiSaveFile {
  schema: number;
  /** どのアプリが書いたか（将来の移行判断用）。 */
  writer?: string;
  rois: SavedRoi[];
  /** 削除済み ROI の墓標。 */
  deleted?: RoiTombstone[];
}

/** 読み込み結果。 */
export interface ParsedRoiFile {
  rois: SavedRoi[];
  deleted: RoiTombstone[];
}

/**
 * 墓標の保持上限。無制限に増やすと保存が膨らむため、**新しい順**に切る。
 * 刈り取られた墓標の ROI を、そのとき開いたままのウィンドウが保持していれば復活し得るが、
 * それには「1 万件削除するあいだ開いたまま」が必要で、実運用では起こらない。
 */
export const MAX_TOMBSTONES = 10_000;

/** 変換元の annotation（Cornerstone の実体をダックタイピングで受ける）。 */
export interface AnnotationLike {
  annotationUID?: string;
  isVisible?: boolean;
  isLocked?: boolean;
  metadata?: { toolName?: string; referencedImageId?: string };
  data?: {
    handles?: { points?: number[][] };
    contour?: { polyline?: number[][]; closed?: boolean };
    polyline?: number[][];
    isOpenContour?: boolean;
  };
}

/** 変換に必要な周辺情報（呼び出し側が Cornerstone から集めて渡す）。 */
export interface RoiSaveContext {
  /** annotation の referencedImageId → SOP Instance UID。解決できなければ null。 */
  sopOf: (imageId: string) => string | null;
  /** annotationUID → ROI マネージャのメタ。 */
  metaOf: (roiUid: string) => {
    label?: string;
    description?: string;
    scope?: RoiScope;
    origin?: RoiScope;
    custom?: Record<string, string>;
  } | undefined;
  /** 現在表示中の ZCT（scope 未登録の ROI に補う）。 */
  ct?: { c: number; t: number; studyUid?: string; seriesUid?: string };
}

const isPoint3 = (p: unknown): p is number[] =>
  Array.isArray(p) && p.length >= 3 && p.every((n) => typeof n === "number" && Number.isFinite(n));

const points3 = (arr: unknown): number[][] => {
  if (!Array.isArray(arr)) return [];
  // 3 要素へ切り詰める（Cornerstone は Point3 だが余分が付くことがある）。
  return arr.filter(isPoint3).map((p) => [p[0], p[1], p[2]]);
};

/**
 * annotation → 保存形（純関数）。**保存できない ROI は null**（黙って壊れた形で保存しない）。
 *
 * <p>落とす条件: UID が無い / ツール名が無い / SOP を解決できない（＝どのインスタンスに
 * 属するか分からない ROI は復元先も決まらない）/ ハンドルも polyline も無い。
 */
export function toSavedRoi(ann: AnnotationLike, ctx: RoiSaveContext): SavedRoi | null {
  const roiUid = ann.annotationUID;
  const tool = ann.metadata?.toolName;
  const refId = ann.metadata?.referencedImageId;
  if (!roiUid || !tool || !refId) return null;
  const sop = ctx.sopOf(refId);
  if (!sop) return null;

  const points = points3(ann.data?.handles?.points);
  const polyline = points3(ann.data?.contour?.polyline ?? ann.data?.polyline);
  if (!points.length && !polyline.length) return null;

  const meta = ctx.metaOf(roiUid);
  const out: SavedRoi = {
    roiUid,
    tool,
    sopInstanceUid: sop,
    points,
  };
  if (polyline.length) out.polyline = polyline;
  // スプライン系は補間方法も保存する（復元時に同じ形へ戻すため）
  const splineType = (ann.data as { spline?: { type?: string } } | undefined)?.spline?.type;
  if (typeof splineType === "string" && splineType) out.splineType = splineType;
  const open = ann.data?.isOpenContour ?? (ann.data?.contour?.closed === false ? true : undefined);
  if (open !== undefined) out.isOpenContour = open;
  if (ctx.ct?.studyUid) out.studyUid = ctx.ct.studyUid;
  if (ctx.ct?.seriesUid) out.seriesUid = ctx.ct.seriesUid;
  if (ctx.ct) {
    out.c = ctx.ct.c;
    out.t = ctx.ct.t;
  }
  if (meta?.label) out.label = meta.label;
  if (meta?.description) out.description = meta.description;
  if (meta?.scope) out.scope = meta.scope;
  if (meta?.origin) out.origin = meta.origin;
  if (meta?.custom && Object.keys(meta.custom).length) out.custom = { ...meta.custom };
  if (ann.isVisible === false) out.isVisible = false;
  if (ann.isLocked === true) out.isLocked = true;
  return out;
}

/**
 * 保存ファイルを組む。`rois` の件数は backend の検証（roiCount）と一致させる必要がある。
 * 墓標は新しい順に {@link MAX_TOMBSTONES} 件へ切る。
 */
export function buildSaveFile(rois: SavedRoi[], deleted: RoiTombstone[] = [], writer?: string): RoiSaveFile {
  const trimmed = [...deleted]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_TOMBSTONES);
  return { schema: ROI_SCHEMA_VERSION, writer, rois, deleted: trimmed };
}

/**
 * 保存ファイルを読む（純関数）。**壊れた要素は個別に落として残りを活かす**
 * （1 件の破損で患者の全 ROI を失わないため）。読めなければ空配列。
 */
export function parseSaveFile(json: string | null | undefined): ParsedRoiFile {
  const empty: ParsedRoiFile = { rois: [], deleted: [] };
  if (!json) return empty;
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return empty;
  }
  const file = root as Partial<RoiSaveFile> | null;
  if (!file || !Array.isArray(file.rois)) return empty;
  // 将来 schema を上げたときは、ここで版ごとの移行を挟む。未知の（新しい）版は読まない
  // ＝古いアプリが新しい保存を取りこぼす方が、誤解釈して座標を壊すより安全。
  if (typeof file.schema === "number" && file.schema > ROI_SCHEMA_VERSION) return empty;

  const deleted: RoiTombstone[] = [];
  const buried = new Set<string>();
  if (Array.isArray(file.deleted)) {
    for (const d of file.deleted as unknown[]) {
      const t = d as Partial<RoiTombstone> | null;
      if (!t || typeof t.roiUid !== "string" || !t.roiUid) continue;
      const at = typeof t.at === "string" ? t.at : "";
      deleted.push({ roiUid: t.roiUid, at });
      buried.add(t.roiUid);
    }
  }

  const out: SavedRoi[] = [];
  for (const r of file.rois as unknown[]) {
    const s = r as Partial<SavedRoi> | null;
    if (!s || typeof s.roiUid !== "string" || !s.roiUid) continue;
    if (typeof s.tool !== "string" || !s.tool) continue;
    if (typeof s.sopInstanceUid !== "string" || !s.sopInstanceUid) continue;
    // 墓標に載っている UID は復元しない（マージ漏れがあっても復活させない＝多重防御）。
    if (buried.has(s.roiUid)) continue;
    const points = points3(s.points);
    const polyline = points3(s.polyline);
    if (!points.length && !polyline.length) continue;
    const item: SavedRoi = { roiUid: s.roiUid, tool: s.tool, sopInstanceUid: s.sopInstanceUid, points };
    if (polyline.length) item.polyline = polyline;
    if (typeof s.isOpenContour === "boolean") item.isOpenContour = s.isOpenContour;
    if (typeof s.studyUid === "string") item.studyUid = s.studyUid;
    if (typeof s.seriesUid === "string") item.seriesUid = s.seriesUid;
    if (typeof s.c === "number") item.c = s.c;
    if (typeof s.t === "number") item.t = s.t;
    if (typeof s.label === "string") item.label = s.label;
    if (typeof s.description === "string") item.description = s.description;
    if (s.scope && typeof s.scope === "object") item.scope = sanitizeScope(s.scope);
    if (s.origin && typeof s.origin === "object") item.origin = sanitizeScope(s.origin);
    if (s.custom && typeof s.custom === "object") item.custom = sanitizeCustom(s.custom);
    if (s.isVisible === false) item.isVisible = false;
    if (s.isLocked === true) item.isLocked = true;
    out.push(item);
  }
  return { rois: out, deleted };
}

const dim = (v: unknown): DimScope | undefined => {
  if (v === "all") return "all";
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

function sanitizeScope(s: Partial<RoiScope>): RoiScope {
  const out: RoiScope = {};
  if (typeof s.studyUid === "string") out.studyUid = s.studyUid;
  if (typeof s.seriesUid === "string") out.seriesUid = s.seriesUid;
  const z = dim(s.z);
  const c = dim(s.c);
  const t = dim(s.t);
  if (z !== undefined) out.z = z;
  if (c !== undefined) out.c = c;
  if (t !== undefined) out.t = t;
  return out;
}

/** 値は文字列だけ通す（プラグインが数値等を書き込んでいても壊れないようにする）。 */
function sanitizeCustom(c: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/**
 * 復元対象を絞る（純関数）。**SOP が現在のスタックに無い ROI は復元しない**
 * （別シリーズの ROI を今見ているシリーズへ載せると座標の意味が壊れる）。
 *
 * @param saved 保存されていた ROI
 * @param imageIdOfSop SOP Instance UID → 現在のスタックの imageId（無ければ null）
 * @param alreadyPresent 既に annotation state にある UID（二重復元を防ぐ）
 */
export function selectRestorable(
  saved: SavedRoi[],
  imageIdOfSop: (sop: string) => string | null,
  alreadyPresent: (roiUid: string) => boolean,
): Array<{ roi: SavedRoi; imageId: string }> {
  const out: Array<{ roi: SavedRoi; imageId: string }> = [];
  for (const roi of saved) {
    if (alreadyPresent(roi.roiUid)) continue;
    const imageId = imageIdOfSop(roi.sopInstanceUid);
    if (!imageId) continue;
    out.push({ roi, imageId });
  }
  return out;
}

/**
 * 保存形 → annotation の `data`（純関数）。Cornerstone が要求する形に組み立てる。
 * `textBox` は空で作る（表示位置は Cornerstone が再計算する）。
 */
export function buildAnnotationData(roi: SavedRoi): Record<string, unknown> {
  const emptyTextBox = () => ({ hasMoved: false, worldPosition: [0, 0, 0], worldBoundingBox: null });
  const data: Record<string, unknown> = {
    handles: {
      points: roi.points.length ? roi.points : [roi.polyline![0], roi.polyline![roi.polyline!.length - 1]],
      activeHandleIndex: null,
      textBox: emptyTextBox(),
    },
    // 復元直後は統計を持たせない。Cornerstone が描画時に計算し直す
    // （古い統計を持ち回ると、校正が変わった場合に嘘の値が残る）。
    cachedStats: {},
  };
  if (roi.polyline?.length) {
    const closed = !roi.isOpenContour;
    data.contour = { polyline: roi.polyline, closed };
    data.polyline = roi.polyline;
    data.isOpenContour = !closed;
  }
  if (roi.splineType) {
    // インスタンスは持たせない（ツールが type から作り直す）。type だけ復元する。
    data.spline = { type: roi.splineType };
  }
  return data;
}

/** 保存形 → ROI マネージャのメタ（`setRoiMaskMeta` に渡す形）。 */
export function buildRestoredMeta(
  roi: SavedRoi,
  patientKey: string,
  seriesLabel?: string,
): {
  patientKey: string;
  seriesLabel?: string;
  label?: string;
  description?: string;
  scope?: RoiScope;
  origin?: RoiScope;
  custom?: Record<string, string>;
} {
  return {
    patientKey,
    seriesLabel,
    label: roi.label,
    description: roi.description,
    scope: roi.scope,
    origin: roi.origin ?? roi.scope,
    custom: roi.custom,
  };
}

/**
 * 保存の衝突時に混ぜる（純関数）。**同じ患者を別ウィンドウで開いている**場合に使う。
 *
 * <p>規則:
 * <ol>
 *   <li>ROI は `roiUid` で**和**を取る（相手が測ったものを消さない）。同じ UID はローカルを採る
 *       ＝いま保存しようとしている側の編集を反映する。</li>
 *   <li>墓標も**和**を取り、<b>墓標に載った UID は結果から除く</b>。これで片方の削除が伝播する。
 *       `annotationUID` は再利用されないので、時刻を比べる必要はない。</li>
 * </ol>
 *
 * <p>順序は UID で決定的にする（保存内容が呼び出し順で変わらないように）。
 */
export function mergeSaveFiles(remote: ParsedRoiFile, local: ParsedRoiFile): ParsedRoiFile {
  const tombs = new Map<string, RoiTombstone>();
  for (const t of remote.deleted) tombs.set(t.roiUid, t);
  // 同じ UID の墓標は新しい方（＝ローカル）を採る。至上の目的は「載っているか」なので実害は無いが、
  // 監査で見たときに直近の削除時刻が残る方が有用。
  for (const t of local.deleted) tombs.set(t.roiUid, t);

  const byUid = new Map<string, SavedRoi>();
  for (const r of remote.rois) byUid.set(r.roiUid, r);
  for (const l of local.rois) byUid.set(l.roiUid, l);
  for (const uid of tombs.keys()) byUid.delete(uid);

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    rois: [...byUid.values()].sort((a, b) => cmp(a.roiUid, b.roiUid)),
    deleted: [...tombs.values()].sort((a, b) => cmp(a.roiUid, b.roiUid)),
  };
}

/**
 * 消えた ROI の墓標を作る（純関数）。
 *
 * <p>「読み込んだ／前回保存した UID の集合」から「いま annotation state にある UID の集合」を引いた
 * 差が削除された ROI である。**ユーザーの削除操作を捕まえるのではなく差分で出す**のは、
 * 削除の経路が複数ある（個別 Delete / ROI マネージャ / 全消去 / undo）ため取りこぼしを避けたいから。
 *
 * @param known   前回時点で存在していた UID
 * @param present いま存在している UID
 * @param now     削除時刻（ISO-8601。テスト可能にするため引数で受ける）
 */
export function tombstonesFor(known: Iterable<string>, present: Set<string>, now: string): RoiTombstone[] {
  const out: RoiTombstone[] = [];
  for (const uid of known) {
    if (!present.has(uid)) out.push({ roiUid: uid, at: now });
  }
  return out;
}
