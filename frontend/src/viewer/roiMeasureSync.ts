/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 台帳（`roiLedger`）の 3D 定規と患者単位ドキュメントの `measures3d` をつなぐ。`roiSolidSync.ts` と同じ規律:
 * 読み込みはシリーズ単位、保存は変わったシリーズだけ、読む前のシリーズは保存しない
 * （読む前に保存すると保存済みを「窓に無い＝消した」とみなして墓標を立てる）、取り込みは編集通知なし、
 * 版・known は動かさない。
 */
import { log } from "../log";
import { onRoiSaved } from "./roiChangeChannel";
import { hydrateMeasure3dSeries, listMeasure3d, subscribeMeasure3dEdits } from "./roiLedger";
import { mergeMeasures, type Measure3d } from "./roiMeasure3d";
import { parseSaveFile } from "./roiPersistence";
import { fetchRoiDocument } from "./roiPersistenceApi";
import { getMeasures3dForSeries, loadRoisCached, mergeRemoteMeasures, setMeasures3dForSeries } from "./roiSaveStore";

const SAVE_DELAY_MS = 800;
const REMOTE_DELAY_MS = 200;
const keyOf = (pk: string, seriesUid: string): string => `${pk}\u0000${seriesUid}`;

const synced = new Map<string, string>();
const dump = (xs: Measure3d[]): string => JSON.stringify([...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

/** このシリーズの保存済み定規を台帳へ読む（シリーズごとに 1 回）。 */
export async function hydrateMeasuresForSeries(patientKey: string, seriesUid: string): Promise<void> {
  if (!patientKey || !seriesUid) return;
  await loadRoisCached(patientKey);
  const key = keyOf(patientKey, seriesUid);
  if (synced.has(key)) return;
  const saved = getMeasures3dForSeries(patientKey, seriesUid);
  const local = listMeasure3d(seriesUid);
  const localIds = new Set(local.map((x) => x.id));
  hydrateMeasure3dSeries(seriesUid, [...saved.filter((x) => !localIds.has(x.id)), ...local]);
  synced.set(key, local.length ? "" : dump(listMeasure3d(seriesUid)));
  if (local.length) void flush(patientKey);
}

async function flush(patientKey: string): Promise<void> {
  const prefix = `${patientKey}\u0000`;
  for (const [key, last] of [...synced]) {
    if (!key.startsWith(prefix)) continue;
    const seriesUid = key.slice(prefix.length);
    const cur = listMeasure3d(seriesUid);
    const text = dump(cur);
    if (text === last) continue;
    synced.set(key, text);
    await setMeasures3dForSeries(patientKey, seriesUid, cur);
  }
}

/** 他の窓が保存した定規を取り込む（真実はバックエンド。編集通知なし＝取り込んだものを保存し直さない）。 */
export async function applyRemoteMeasures(patientKey: string): Promise<void> {
  const prefix = `${patientKey}\u0000`;
  const keys = [...synced.keys()].filter((k) => k.startsWith(prefix));
  if (!keys.length) return;
  let parsed: ReturnType<typeof parseSaveFile>;
  try {
    parsed = parseSaveFile((await fetchRoiDocument(patientKey)).json);
  } catch (e) {
    log.warn("roi remote fetch failed", patientKey, e);
    return;
  }
  const buried = new Set(parsed.deleted.map((t) => t.roiUid));
  mergeRemoteMeasures(patientKey, parsed.measures3d, buried);
  for (const key of keys) {
    if (!synced.has(key)) continue;
    const seriesUid = key.slice(prefix.length);
    const local = listMeasure3d(seriesUid);
    const merged = mergeMeasures(parsed.measures3d.filter((x) => x.seriesUid === seriesUid), local, buried);
    if (dump(merged) === dump(local)) continue;
    const clean = dump(local) === synced.get(key);
    hydrateMeasure3dSeries(seriesUid, merged);
    if (clean) synced.set(key, dump(merged));
  }
}

/** 台帳の編集を聞いてデバウンス保存し、他窓の保存も取り込む。戻り値は解除（保留中の保存は流し切る）。 */
export function startMeasureAutosave(patientKey: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remoteTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubRemote = onRoiSaved((pk) => {
    if (pk !== patientKey) return;
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      remoteTimer = null;
      void applyRemoteMeasures(patientKey);
    }, REMOTE_DELAY_MS);
  });
  const unsub = subscribeMeasure3dEdits(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush(patientKey);
    }, SAVE_DELAY_MS);
  });
  return () => {
    unsub();
    unsubRemote();
    if (remoteTimer) clearTimeout(remoteTimer);
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void flush(patientKey);
    }
  };
}

/** 窓がそのシリーズを手放すとき。以後は保存も取り込みもしない。 */
export function forgetMeasureSync(patientKey: string, seriesUid: string): void {
  synced.delete(keyOf(patientKey, seriesUid));
}

/** テスト用。 */
export function resetMeasureSync(): void {
  synced.clear();
}
