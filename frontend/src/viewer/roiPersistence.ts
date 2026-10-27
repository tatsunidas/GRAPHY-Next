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
import { isContourTool } from "./roiContourTools";

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
  /**
   * マルチフレーム・インスタンス内の**フレーム番号（0 origin）**。単一フレームなら省略。
   *
   * <p>🚨 **`sopInstanceUid` だけでは復元先が決まらない。** XA の 1 ラン数十〜数百フレームは
   * すべて**同じ SOP Instance UID** を持つので、SOP を鍵に解決すると
   * **必ず 1 フレーム目**に戻る（実機で「解析したフレームには無く、1 フレーム目に出る」
   * という形で発覚・2026-08-28）。
   *
   * <p>🔴 **表示中の T ではなく、その ROI 自身の `referencedImageId` から取る。**
   * 保存は全 ROI をまとめて集めるので、表示中の値を配ると**別フレームの ROI に
   * 今見ているフレーム番号を書く**（`t` を保存していないのも同じ理由）。
   */
  frame?: number;
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
  /**
   * ROI グループ（同じ `groupId` の ROI が 1 つのグループ）。名前は所属 ROI に持たせる＝グループは
   * メンバーがいる間だけ存在する。🔴 **`schema` を上げずに足した項目**: 知らない旧アプリは無視して
   * 読む（ROI は無傷、グループ所属だけが外れる）。
   */
  groupId?: string;
  groupName?: string;
  isVisible?: boolean;
  isLocked?: boolean;
}

/**
 * 保存する 3D 球 ROI 1 件（`sphere3dStore`）。中心＋半径のパラメータだけで、ラスタ化結果は持たない。
 * 🔴 `sphere3dStore` の `id` はセッション連番で別ウィンドウ・別セッションと衝突するので、
 * 鍵は保存用の安定 ID `uid`（墓標の `roiUid` にもこれを入れる。UUID なので ROI の UID と衝突しない）。
 */
export interface SavedSphere {
  uid: string;
  studyUid: string;
  seriesUid: string;
  /** 作成スライスの SOP Instance UID。復元時に imageId へ解決する鍵（imageId はセッション固有なので保存しない）。 */
  refSopInstanceUid: string;
  /** 中心（患者座標 LPS mm）。 */
  center: [number, number, number];
  radiusMm: number;
  c: DimScope;
  t: DimScope;
  label?: string;
  color: string;
  visible: boolean;
  groupId?: string;
  groupName?: string;
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
  /**
   * 旧版が書いた QCA / QVA の解析状態。**中身は読まず、そのまま持ち越す**（2D QCA は本体から外れたが、
   * 古い保存ファイルを上書きしても失わないため。プラグイン側が使う余地も残す）。
   *
   * <p>🔴 これを足すために `schema` を上げていない。{@link parseSaveFile} は「自分より新しい版は読まない」ので、
   * 版を上げると古いアプリがその患者の ROI を丸ごと空として読む（＝画面から注釈が消える）。
   */
  analyses?: unknown[];
  /**
   * 3D 球 ROI。🔴 **これを足すために `schema` を上げていない**（`analyses` と同じ理由）。
   * 古いアプリは無視して読む（ROI は無傷）。古いアプリが上書き保存すると球だけは失われる。
   */
  spheres?: SavedSphere[];
}

/** 読み込み結果。 */
export interface ParsedRoiFile {
  rois: SavedRoi[];
  deleted: RoiTombstone[];
  /** 旧版の解析状態（中身は読まない。無ければ空配列）。 */
  analyses: unknown[];
  /** 3D 球 ROI（無ければ空配列）。 */
  spheres: SavedSphere[];
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
  /**
   * annotation の referencedImageId → フレーム番号（0 origin）。単一フレームなら null。
   * 省略するとフレームを記録しない＝マルチフレームで復元先を誤る。
   */
  frameOf?: (imageId: string) => number | null;
  /** annotationUID → ROI マネージャのメタ。 */
  metaOf: (roiUid: string) => {
    label?: string;
    description?: string;
    scope?: RoiScope;
    origin?: RoiScope;
    custom?: Record<string, string>;
    groupId?: string;
    groupName?: string;
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
  // マルチフレームの復元先。**その ROI 自身の imageId** から取る（表示中の値ではない）。
  const frame = ctx.frameOf?.(refId);
  if (typeof frame === "number" && Number.isFinite(frame) && frame >= 0) out.frame = frame;
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
  if (meta?.groupId) {
    out.groupId = meta.groupId;
    if (meta.groupName) out.groupName = meta.groupName;
  }
  if (ann.isVisible === false) out.isVisible = false;
  if (ann.isLocked === true) out.isLocked = true;
  return out;
}

/**
 * 保存ファイルを組む。`rois` の件数は backend の検証（roiCount）と一致させる必要がある。
 * 墓標は新しい順に {@link MAX_TOMBSTONES} 件へ切る。
 */
export function buildSaveFile(
  rois: SavedRoi[],
  deleted: RoiTombstone[] = [],
  writer?: string,
  analyses: unknown[] = [],
  spheres: SavedSphere[] = [],
): RoiSaveFile {
  const trimmed = [...deleted]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_TOMBSTONES);
  const buried = new Set(trimmed.map((t) => t.roiUid));
  const liveSpheres = spheres.filter((sp) => !buried.has(sp.uid));
  return {
    schema: ROI_SCHEMA_VERSION,
    writer,
    rois,
    deleted: trimmed,
    analyses,
    // 球が無いときはキー自体を出さない（球を使わない患者の保存内容を変えない）。
    ...(liveSpheres.length ? { spheres: liveSpheres } : {}),
  };
}

/**
 * 保存ファイルを読む（純関数）。**壊れた要素は個別に落として残りを活かす**
 * （1 件の破損で患者の全 ROI を失わないため）。読めなければ空配列。
 */
export function parseSaveFile(json: string | null | undefined): ParsedRoiFile {
  const empty: ParsedRoiFile = { rois: [], deleted: [], analyses: [], spheres: [] };
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
    // スプライン Fit の状態。落とすと再読み込みで直線に戻る（そのための保存項目）。
    if (typeof s.splineType === "string" && s.splineType) item.splineType = s.splineType;
    if (typeof s.studyUid === "string") item.studyUid = s.studyUid;
    if (typeof s.seriesUid === "string") item.seriesUid = s.seriesUid;
    if (typeof s.c === "number") item.c = s.c;
    if (typeof s.t === "number") item.t = s.t;
    if (typeof s.frame === "number" && Number.isFinite(s.frame) && s.frame >= 0) item.frame = s.frame;
    if (typeof s.label === "string") item.label = s.label;
    if (typeof s.description === "string") item.description = s.description;
    if (s.scope && typeof s.scope === "object") item.scope = sanitizeScope(s.scope);
    if (s.origin && typeof s.origin === "object") item.origin = sanitizeScope(s.origin);
    if (s.custom && typeof s.custom === "object") item.custom = sanitizeCustom(s.custom);
    if (typeof s.groupId === "string" && s.groupId) {
      item.groupId = s.groupId;
      if (typeof s.groupName === "string") item.groupName = s.groupName;
    }
    if (s.isVisible === false) item.isVisible = false;
    if (s.isLocked === true) item.isLocked = true;
    out.push(item);
  }
  // 旧版の解析状態は中身を検証せず素通しにする（読めない形でも失わない。墓標との突き合わせもしない）。
  const analysesRaw = (file as { analyses?: unknown }).analyses;
  const analyses: unknown[] = Array.isArray(analysesRaw) ? analysesRaw : [];
  const spheres: SavedSphere[] = [];
  if (Array.isArray((file as { spheres?: unknown }).spheres)) {
    const seen = new Set<string>();
    for (const sp of (file as { spheres: unknown[] }).spheres) {
      const parsed = sanitizeSphere(sp);
      if (!parsed || buried.has(parsed.uid) || seen.has(parsed.uid)) continue;
      seen.add(parsed.uid);
      spheres.push(parsed);
    }
  }
  return { rois: out, deleted, analyses, spheres };
}

/** 球 1 件の検証。必須項目が欠ける・数値が壊れているものは null（復元できないので落とす）。 */
function sanitizeSphere(raw: unknown): SavedSphere | null {
  const s = raw as Partial<SavedSphere> | null;
  if (!s || typeof s !== "object") return null;
  if (typeof s.uid !== "string" || !s.uid) return null;
  if (typeof s.seriesUid !== "string" || !s.seriesUid) return null;
  if (typeof s.refSopInstanceUid !== "string" || !s.refSopInstanceUid) return null;
  if (!Array.isArray(s.center) || s.center.length !== 3 || !s.center.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  if (typeof s.radiusMm !== "number" || !Number.isFinite(s.radiusMm) || s.radiusMm <= 0) return null;
  const out: SavedSphere = {
    uid: s.uid,
    studyUid: typeof s.studyUid === "string" ? s.studyUid : "",
    seriesUid: s.seriesUid,
    refSopInstanceUid: s.refSopInstanceUid,
    center: [s.center[0], s.center[1], s.center[2]],
    radiusMm: s.radiusMm,
    c: dim(s.c) ?? "all",
    t: dim(s.t) ?? "all",
    color: typeof s.color === "string" && s.color ? s.color : "#00e5ff",
    visible: s.visible !== false,
  };
  if (typeof s.label === "string") out.label = s.label;
  if (typeof s.groupId === "string" && s.groupId) {
    out.groupId = s.groupId;
    if (typeof s.groupName === "string") out.groupName = s.groupName;
  }
  return out;
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
 * <p>🚨 **解決には SOP とフレームの両方を渡す。** マルチフレーム（XA の 1 ラン）は
 * 全フレームが同じ SOP を持つので、SOP だけで解くと**必ず 1 フレーム目**に戻る。
 *
 * @param saved 保存されていた ROI
 * @param imageIdOf (SOP Instance UID, フレーム番号) → 現在のスタックの imageId（無ければ null）
 * @param alreadyPresent 既に annotation state にある UID（二重復元を防ぐ）
 */
export function selectRestorable(
  saved: SavedRoi[],
  imageIdOf: (sop: string, frame?: number) => string | null,
  alreadyPresent: (roiUid: string) => boolean,
): Array<{ roi: SavedRoi; imageId: string }> {
  const out: Array<{ roi: SavedRoi; imageId: string }> = [];
  for (const roi of saved) {
    if (alreadyPresent(roi.roiUid)) continue;
    const imageId = imageIdOf(roi.sopInstanceUid, roi.frame);
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
  } else if (isContourTool(roi.tool)) {
    // polyline を保存できていない輪郭系 ROI でも**入れ物は必ず作る**。
    // 無いと描画時に `data.contour.closed` を読んで落ち、以後 ROI が描けなくなる。
    // 実際の輪郭は制御点から再計算される。
    data.contour = { polyline: [], closed: !roi.isOpenContour };
    data.isOpenContour = !!roi.isOpenContour;
  }
  if (roi.splineType) {
    // インスタンスはここでは作らない（ツールに作らせる＝ roiRestore の ensureSplineInstance）。
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
  groupId?: string;
  groupName?: string;
} {
  return {
    patientKey,
    seriesLabel,
    label: roi.label,
    description: roi.description,
    scope: roi.scope,
    origin: roi.origin ?? roi.scope,
    custom: roi.custom,
    groupId: roi.groupId,
    groupName: roi.groupName,
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
  // 旧版の解析状態は中身を読まないので突き合わせられない。いまの保存内容（remote）を正とし、
  // 空のときだけローカルが持ち越したものを使う。
  const analyses = remote.analyses.length ? remote.analyses : local.analyses;
  // 球も `uid` で和集合（同じ uid はローカル）。墓標に載った球は落とす。
  const sphereByUid = new Map<string, SavedSphere>();
  for (const sp of remote.spheres) sphereByUid.set(sp.uid, sp);
  for (const sp of local.spheres) sphereByUid.set(sp.uid, sp);
  for (const uid of tombs.keys()) sphereByUid.delete(uid);
  return {
    rois: [...byUid.values()].sort((a, b) => cmp(a.roiUid, b.roiUid)),
    deleted: [...tombs.values()].sort((a, b) => cmp(a.roiUid, b.roiUid)),
    analyses,
    spheres: [...sphereByUid.values()].sort((a, b) => cmp(a.uid, b.uid)),
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
