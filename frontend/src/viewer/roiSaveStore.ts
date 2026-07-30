/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI（幾何注釈）の自動保存・復元の司令塔（`fw/roi-manager-design.md` M5）。
 *
 * <p>役割は 3 つだけで、**Cornerstone にも React にも依存しない**（注入で受ける）。
 * ①変更をデバウンスして保存 ②版の保持と 409（競合）時のマージ再試行 ③削除の差分から墓標を作る。
 * 変換の実体は {@link ./roiPersistence}（純関数）、搬送は {@link ./roiPersistenceApi}。
 *
 * <p><b>なぜ「既知の UID」を持つか</b>: 削除は差分で検出する。ユーザーの削除操作を捕まえる方式だと
 * 経路（個別 Delete / ROI マネージャ / 全消去 / undo）ごとに漏れるため、
 * 「前回時点で存在した UID」から「いま存在する UID」を引いた差を削除とみなす。
 */
import { log } from "../log";
import {
  buildSaveFile,
  mergeSaveFiles,
  parseSaveFile,
  tombstonesFor,
  type ParsedRoiFile,
  type RoiTombstone,
  type SavedRoi,
} from "./roiPersistence";
import { fetchRoiDocument, saveRoiDocument } from "./roiPersistenceApi";

/** 保存 1 回分の結果。UI が「保存済み」表示や失敗通知に使う。 */
export interface RoiSaveResult {
  ok: boolean;
  /** 保存された ROI 件数。 */
  roiCount?: number;
  /** 競合で 1 度マージ再試行したか（監査ログ用）。 */
  merged?: boolean;
  error?: string;
}

/** 患者ごとの保存状態。 */
interface PatientState {
  /** backend の楽観ロック版。未読なら undefined、未保存なら null。 */
  version?: number | null;
  /** 前回の読み込み／保存時点で存在していた ROI の UID。削除の差分検出に使う。 */
  known: Set<string>;
  /** まだ保存できていない墓標（保存が成功するまで持ち越す）。 */
  pendingTombstones: Map<string, RoiTombstone>;
  /** デバウンスのタイマー。 */
  timer?: ReturnType<typeof setTimeout>;
  /** 実行中の保存（多重実行を避ける）。 */
  inflight?: Promise<RoiSaveResult>;
  /** 実行中に更に変更が来たか（保存後にもう 1 度回す）。 */
  dirtyAgain?: boolean;
  /**
   * 直近に読み込んだ／保存した ROI の内容。
   *
   * <p>**表示していないシリーズの ROI を守るために要る**。復元は「表示中スタックに属する ROI」
   * だけを annotation state へ戻すので、別シリーズの ROI はメモリ上に存在しない。
   * 収集結果をそのまま保存すると、それらが「消えた」と判定されて墓標が立ち、**実際に消える**。
   * そこで収集側がこの内容を見て、いま見えていない ROI をそのまま持ち越す。
   */
  loaded: SavedRoi[];
}

/** いま保存すべき内容を集めて返す関数（呼び出し側＝Viewer2D が Cornerstone から集める）。 */
export type RoiCollector = () => SavedRoi[];

const states = new Map<string, PatientState>();
const collectors = new Map<string, RoiCollector>();
const listeners = new Set<(patientKey: string, result: RoiSaveResult) => void>();

/** 既定のデバウンス。ROI のドラッグ中は 1 操作で多数のイベントが出るので、落ち着くまで待つ。 */
export const ROI_SAVE_DEBOUNCE_MS = 1500;

function stateOf(patientKey: string): PatientState {
  let s = states.get(patientKey);
  if (!s) {
    s = { known: new Set(), pendingTombstones: new Map(), loaded: [] };
    states.set(patientKey, s);
  }
  return s;
}

/**
 * 患者の ROI 収集関数を登録する（2D Viewer の画面が開いている間だけ）。
 * 返り値で解除。解除時に**保留中の保存を流し切る**（ウィンドウを閉じて計測が消えるのを防ぐ）。
 */
export function registerRoiCollector(patientKey: string, collect: RoiCollector): () => void {
  collectors.set(patientKey, collect);
  return () => {
    if (collectors.get(patientKey) === collect) {
      const s = states.get(patientKey);
      if (s?.timer) {
        clearTimeout(s.timer);
        s.timer = undefined;
        // 解除の直前に 1 度だけ保存する（await はしない＝アンマウントを待たせない）。
        void saveRoiNow(patientKey);
      }
      collectors.delete(patientKey);
    }
  };
}

/** 保存結果の購読（保存済み表示・失敗通知用）。 */
export function subscribeRoiSave(l: (patientKey: string, result: RoiSaveResult) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function notify(patientKey: string, result: RoiSaveResult): void {
  for (const l of [...listeners]) {
    try {
      l(patientKey, result);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 復元用の読み込みキャッシュ。タイルが複数あると同じ患者の ROI を同時に読もうとするため、
 * **1 患者 1 回の fetch** にまとめる（復元は各タイルが自分のスタック分だけ拾う）。
 */
const loadCache = new Map<string, Promise<ParsedRoiFile>>();

/** 復元用の読み込み（患者単位でキャッシュ）。保存に成功すると自動で無効化される。 */
export function loadRoisCached(patientKey: string): Promise<ParsedRoiFile> {
  let p = loadCache.get(patientKey);
  if (!p) {
    p = loadRois(patientKey);
    loadCache.set(patientKey, p);
  }
  return p;
}

/** 読み込みキャッシュを捨てる（保存後・患者切替時）。 */
export function invalidateRoiCache(patientKey?: string): void {
  if (patientKey) loadCache.delete(patientKey);
  else loadCache.clear();
}

/**
 * 保存済みの ROI を読み出す（復元の入口）。**版と既知 UID をここで確定させる**ので、
 * 復元する側は必ずこれを通す（読まずに保存すると backend が 409 を返す）。
 */
export async function loadRois(patientKey: string): Promise<ParsedRoiFile> {
  const s = stateOf(patientKey);
  try {
    const dto = await fetchRoiDocument(patientKey);
    s.version = dto.version;
    const parsed = parseSaveFile(dto.json);
    // 読んだ時点の UID を「既知」に入れる。以後これが消えたら削除とみなす。
    for (const r of parsed.rois) s.known.add(r.roiUid);
    s.loaded = parsed.rois;
    for (const t of parsed.deleted) s.pendingTombstones.set(t.roiUid, t);
    return parsed;
  } catch (e) {
    log.warn("roi load failed", patientKey, e);
    // 読めなかったときは版を未確定のままにする（未確定だと保存を試みない＝上書き事故を避ける）。
    return { rois: [], deleted: [] };
  }
}

/** 変更を受けて保存を予約する（デバウンス）。 */
export function scheduleRoiSave(patientKey: string, debounceMs = ROI_SAVE_DEBOUNCE_MS): void {
  if (!patientKey || !collectors.has(patientKey)) return;
  const s = stateOf(patientKey);
  if (s.inflight) {
    // 保存中の変更は取りこぼさない（終わってからもう 1 度回す）。
    s.dirtyAgain = true;
    return;
  }
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = undefined;
    void saveRoiNow(patientKey);
  }, debounceMs);
}

/** いま保存する（明示保存・アンマウント時のフラッシュ）。予約済みのデバウンスは取り消す。 */
export function saveRoiNow(patientKey: string): Promise<RoiSaveResult> {
  const s = stateOf(patientKey);
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
  if (s.inflight) {
    s.dirtyAgain = true;
    return s.inflight;
  }
  const run = doSave(patientKey).then(async (result) => {
    s.inflight = undefined;
    notify(patientKey, result);
    if (s.dirtyAgain && result.ok) {
      s.dirtyAgain = false;
      return saveRoiNow(patientKey);
    }
    s.dirtyAgain = false;
    return result;
  });
  s.inflight = run;
  return run;
}

async function doSave(patientKey: string): Promise<RoiSaveResult> {
  const collect = collectors.get(patientKey);
  if (!collect) return { ok: false, error: "no collector" };
  const s = stateOf(patientKey);
  // 版が未確定なら、まず読む（読まずに保存すると backend が 409 を返す仕様）。
  if (s.version === undefined) {
    await loadRois(patientKey);
    if (s.version === undefined) return { ok: false, error: "version unresolved" };
  }

  let rois: SavedRoi[];
  try {
    rois = collect();
  } catch (e) {
    log.warn("roi collect failed", patientKey, e);
    return { ok: false, error: String(e) };
  }
  const present = new Set(rois.map((r) => r.roiUid));
  const now = new Date().toISOString();
  for (const t of tombstonesFor(s.known, present, now)) s.pendingTombstones.set(t.roiUid, t);
  // 生きている ROI は墓標から外す（同じ UID が復活することは無いが、取り違えを防ぐ多重防御）。
  for (const uid of present) s.pendingTombstones.delete(uid);

  const local: ParsedRoiFile = { rois, deleted: [...s.pendingTombstones.values()] };

  try {
    const saved = await put(patientKey, local, s.version);
    commit(s, saved.content, saved.version);
    return { ok: true, roiCount: saved.content.rois.length };
  } catch (e) {
    const msg = String(e);
    // 409 = 別ウィンドウが先に保存した。読み直して**マージ**してから 1 度だけ再試行する
    // （単純な上書きにすると相手の計測が消える）。
    if (!/HTTP 409|版が古い|既に保存|同時に保存|保存先が存在しません/.test(msg)) {
      log.warn("roi save failed", patientKey, e);
      return { ok: false, error: msg };
    }
    try {
      const dto = await fetchRoiDocument(patientKey);
      const remote = parseSaveFile(dto.json);
      const merged = mergeSaveFiles(remote, local);
      const saved = await put(patientKey, merged, dto.version);
      commit(s, saved.content, saved.version);
      return { ok: true, roiCount: saved.content.rois.length, merged: true };
    } catch (e2) {
      log.warn("roi save retry failed", patientKey, e2);
      return { ok: false, error: String(e2), merged: true };
    }
  }
}

async function put(
  patientKey: string,
  content: ParsedRoiFile,
  version: number | null | undefined,
): Promise<{ content: ParsedRoiFile; version: number | null }> {
  const file = buildSaveFile(content.rois, content.deleted, "graphy-next");
  const dto = await saveRoiDocument(patientKey, JSON.stringify(file), file.rois.length, version ?? null);
  // 上限で切られた墓標を状態にも反映するため、保存した内容（＝切られた後）を返す。
  return { content: { rois: file.rois, deleted: file.deleted ?? [] }, version: dto.version };
}

function commit(s: PatientState, content: ParsedRoiFile, version: number | null): void {
  // 保存した内容が最新なので、復元キャッシュは捨てる（次に開くタイルは新しい方を見る）。
  loadCache.clear();
  s.version = version;
  s.known = new Set(content.rois.map((r) => r.roiUid));
  s.pendingTombstones = new Map(content.deleted.map((t) => [t.roiUid, t]));
  s.loaded = content.rois;
}

/**
 * 直近に読み込んだ／保存した ROI（収集側が「いま見えていない ROI」を持ち越すために読む）。
 * これを渡さずに収集すると、表示していないシリーズの ROI が削除扱いになる。
 */
export function getLoadedRois(patientKey: string): SavedRoi[] {
  return states.get(patientKey)?.loaded ?? [];
}

/** テスト・患者切替用に状態を捨てる。 */
export function resetRoiSaveState(patientKey?: string): void {
  if (patientKey) {
    const s = states.get(patientKey);
    if (s?.timer) clearTimeout(s.timer);
    states.delete(patientKey);
    loadCache.delete(patientKey);
    return;
  }
  for (const s of states.values()) {
    if (s.timer) clearTimeout(s.timer);
  }
  states.clear();
  collectors.clear();
  loadCache.clear();
}
