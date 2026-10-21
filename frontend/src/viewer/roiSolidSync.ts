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
import type { Roi3dBox } from "./roi3dBox";
import { hydrateRoi3dSeries, listRoi3d, subscribeRoi3dEdits } from "./roiLedger";
import { getSolidsForSeries, loadRoisCached, setSolidsForSeries } from "./roiSaveStore";

const SAVE_DELAY_MS = 800;
const keyOf = (pk: string, seriesUid: string): string => `${pk}\u0000${seriesUid}`;

/** 読み込み済みのシリーズ → 最後に保存した（または読んだ）内容。 */
const synced = new Map<string, string>();
const dump = (xs: Roi3dBox[]): string => JSON.stringify(xs);

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

/** 台帳の編集を聞いて、デバウンスして保存する。戻り値は解除（保留中の保存は流し切る）。 */
export function startSolidAutosave(patientKey: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = subscribeRoi3dEdits(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush(patientKey);
    }, SAVE_DELAY_MS);
  });
  return () => {
    unsub();
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void flush(patientKey);
    }
  };
}

/** テスト用: 読み込み済みの記録を捨てる。 */
export function resetSolidSync(): void {
  synced.clear();
}
