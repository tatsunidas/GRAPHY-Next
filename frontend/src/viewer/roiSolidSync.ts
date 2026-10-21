/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D 窓の台帳（`roiLedger`）と患者単位ドキュメントの `solids` をつなぐ。`fw/roi-global-manager.md`。
 *
 * <p>2D 窓は複数シリーズのタイルを同時に持つので、**読み込みはシリーズ単位**（{@link hydrateSolidsForSeries}）、
 * **保存は変わったシリーズだけ**（{@link startSolidAutosave}）。
 *
 * <p>🔴 まだ読み込んでいないシリーズは保存しない。読む前に保存すると、保存済みの solid を
 * 「窓に無い＝消した」とみなして墓標を立ててしまう。読み込み前に利用者が作った solid は、
 * 読み込みのときに保存済みと和を取って残す（保存は読み込み後に走る）。
 */
import { log } from "../log";
import { mergeSolids, type Roi3dBox } from "./roi3dBox";
import { onRoiSaved } from "./roiChangeChannel";
import { hydrateRoi3dSeries, listRoi3d, subscribeRoi3dEdits } from "./roiLedger";
import { parseSaveFile } from "./roiPersistence";
import { fetchRoiDocument } from "./roiPersistenceApi";
import { getSolidsForSeries, loadRoisCached, mergeRemoteSolids, setSolidsForSeries } from "./roiSaveStore";

const SAVE_DELAY_MS = 800;
const REMOTE_DELAY_MS = 200;
const keyOf = (pk: string, seriesUid: string): string => `${pk}\u0000${seriesUid}`;

/** 読み込み済みのシリーズ → 最後に保存した（または読んだ）内容。 */
const synced = new Map<string, string>();
/** 順序に依らない比較用の文字列（ledger の並びと保存の並び＝id 順が違っても同じ内容は同じ）。 */
const dump = (xs: Roi3dBox[]): string => JSON.stringify([...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

/** このシリーズの保存済み solid を台帳へ読む（シリーズごとに 1 回）。 */
export async function hydrateSolidsForSeries(patientKey: string, seriesUid: string): Promise<void> {
  if (!patientKey || !seriesUid) return;
  await loadRoisCached(patientKey);
  const key = keyOf(patientKey, seriesUid);
  if (synced.has(key)) return;
  const saved = getSolidsForSeries(patientKey, seriesUid);
  const local = listRoi3d(seriesUid);
  const localIds = new Set(local.map((x) => x.id));
  hydrateRoi3dSeries(seriesUid, [...saved.filter((x) => !localIds.has(x.id)), ...local]);
  // 読み込み前に作られた solid があれば、保存済みと違うので次の保存で書かれる。
  synced.set(key, local.length ? "" : dump(listRoi3d(seriesUid)));
  if (local.length) void flush(patientKey);
}

async function flush(patientKey: string): Promise<void> {
  const prefix = `${patientKey}\u0000`;
  for (const [key, last] of [...synced]) {
    if (!key.startsWith(prefix)) continue;
    const seriesUid = key.slice(prefix.length);
    const cur = listRoi3d(seriesUid);
    const text = dump(cur);
    if (text === last) continue;
    synced.set(key, text);
    await setSolidsForSeries(patientKey, seriesUid, cur);
  }
}

/**
 * 他の窓が保存した solid を取り込む。真実はバックエンド: 取り直して、読み込み済みのシリーズごとに
 * 「他窓の保存分＋この窓の現在値」を `mergeSolids`（updatedAt の新しい方・墓標で削除）で混ぜる。
 * 台帳へは編集通知なしで反映する（取り込んだものを保存し直さない）。
 */
export async function applyRemoteSolids(patientKey: string): Promise<void> {
  const prefix = `${patientKey}\u0000`;
  const keys = [...synced.keys()].filter((k) => k.startsWith(prefix));
  if (!keys.length) return; // この窓はその患者の solid を持っていない
  let parsed: ReturnType<typeof parseSaveFile>;
  try {
    parsed = parseSaveFile((await fetchRoiDocument(patientKey)).json);
  } catch (e) {
    log.warn("roi remote fetch failed", patientKey, e);
    return;
  }
  const buried = new Set(parsed.deleted.map((t) => t.roiUid));
  mergeRemoteSolids(patientKey, parsed.solids, buried);
  for (const key of keys) {
    if (!synced.has(key)) continue; // 取得の間に忘れられた
    const seriesUid = key.slice(prefix.length);
    const local = listRoi3d(seriesUid);
    const merged = mergeSolids(parsed.solids.filter((x) => x.seriesUid === seriesUid), local, buried);
    if (dump(merged) === dump(local)) continue;
    // 未保存の編集が無ければ、取り込んだ内容が新しい同期点（次の保存の差分に入れない）。
    const clean = dump(local) === synced.get(key);
    hydrateRoi3dSeries(seriesUid, merged);
    if (clean) synced.set(key, dump(merged));
  }
}

/** 台帳の編集を聞いて、デバウンスして保存する。他窓の保存も聞いて取り込む。戻り値は解除（保留中の保存は流し切る）。 */
export function startSolidAutosave(patientKey: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remoteTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubRemote = onRoiSaved((pk) => {
    if (pk !== patientKey) return;
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      remoteTimer = null;
      void applyRemoteSolids(patientKey);
    }, REMOTE_DELAY_MS);
  });
  const unsub = subscribeRoi3dEdits(() => {
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

/** 窓がそのシリーズを手放すとき（MPR を閉じる等）。以後は保存も取り込みもしない。 */
export function forgetSolidSync(patientKey: string, seriesUid: string): void {
  synced.delete(keyOf(patientKey, seriesUid));
}

/** テスト用: 読み込み済みの記録を捨てる。 */
export function resetSolidSync(): void {
  synced.clear();
}
