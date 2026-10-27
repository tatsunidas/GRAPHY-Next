/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 塗り ROI（マスク）の保存と復元の段取り（Cornerstone とネットワークに触る層）。
 *
 * <p>形の ROI（`roiSaveStore.ts`）との違い: 画素が大きいので**変更があったマスクだけ**を 1 件ずつ書く。
 * 判断（何を保存するか・何を戻すか・圧縮）は純関数の {@link ./maskPersistence} に置いてある。
 *
 * <p>🔴 **削除は「利用者が消した」ときだけ**（`subscribeRoiMaskDeleted`）。タイルを閉じる・キャッシュから
 * 画像が落ちる、でマスクが見えなくなっても、保存済みの行には触らない（差分で消すと、シリーズを開いて
 * いないだけで保存済みのマスクを消してしまう）。
 */
import { eventTarget } from "@cornerstonejs/core";
import { segmentation as csSeg, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { log } from "../log";
import { tOutsideReact } from "../i18n/i18n";
import { HttpError } from "../http";
import { emitToast } from "./toast";
import { getViewerContext } from "./viewerContext";
import { extractMaskFrames, importMaskFrames } from "./maskFrames";
import { isPluginLabelVolume } from "./labelVolumeOrigin";
import { getRoiMaskMeta, setRoiMaskMeta, subscribeRoiMaskDeleted, subscribeRoiMaskStore } from "./roiMaskStore";
import {
  contentFingerprint,
  countFrames,
  decodeFrames,
  encodeFrames,
  framesFingerprintInput,
  maskMetaSignature,
  maskSeriesUid,
  selectMasksToRestore,
  toSavedMaskMeta,
} from "./maskPersistence";
import { deleteMask, fetchMaskFrames, listMasks, saveMask } from "./maskPersistenceApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/** 変更のあと、このあいだ静かになってから保存する（塗りのドラッグ中は 1 操作で多数のイベントが出る）。 */
export const MASK_SAVE_DEBOUNCE_MS = 500;

/** 保存済みの行: `persistUid` → この窓のマスク ID と、最後に知っている版。 */
const known = new Map<string, { maskId: string; version: number | null }>();
/** マスク ID → 最後に保存／復元したメタの署名（メタの変更検知）。 */
const lastSig = new Map<string, string>();
/** マスク ID → 最後に保存／復元した内容の指紋。同じなら送らない。 */
const lastFp = new Map<string, string>();
const dirty = new Set<string>();
const restoring = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<void> = Promise.resolve();
let failureToasted = false;

function allMaskIds(): string[] {
  try {
    return (((csSeg.state as AnyObj).getSegmentations?.() ?? []) as { segmentationId: string }[]).map((s) => s.segmentationId);
  } catch {
    return [];
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, MASK_SAVE_DEBOUNCE_MS);
}

/** メタが変わった（または未保存の）マスクを dirty にする。 */
function markDirtyByMeta(): void {
  let any = false;
  for (const id of allMaskIds()) {
    if (isPluginLabelVolume(id)) continue;
    const saved = toSavedMaskMeta(getRoiMaskMeta(id));
    if (!saved) continue;
    if (lastSig.get(id) !== maskMetaSignature(saved)) {
      dirty.add(id);
      any = true;
    }
  }
  if (any) schedule();
}

/** 保存の開始。画面が開いている間だけ呼ぶ。返り値で停止（保留中の保存は流し切る）。 */
export function startMaskPersistence(): () => void {
  const ev = csToolsEnums.Events;
  const onData = (e: Event): void => {
    const id = (e as CustomEvent<{ segmentationId?: string }>).detail?.segmentationId;
    if (!id || isPluginLabelVolume(id) || !toSavedMaskMeta(getRoiMaskMeta(id))) return;
    dirty.add(id);
    schedule();
  };
  if (ev.SEGMENTATION_DATA_MODIFIED) eventTarget.addEventListener(ev.SEGMENTATION_DATA_MODIFIED, onData);
  const unsubMeta = subscribeRoiMaskStore(markDirtyByMeta);
  const unsubDeleted = subscribeRoiMaskDeleted((id, meta) => {
    dirty.delete(id);
    lastSig.delete(id);
    lastFp.delete(id);
    const uid = meta?.persistUid;
    if (!uid || !meta?.patientKey) return;
    known.delete(uid);
    const pk = meta.patientKey;
    enqueue(async () => {
      try {
        await deleteMask(uid, pk);
      } catch (e) {
        log.warn("mask delete failed", uid, e);
      }
    });
  });
  markDirtyByMeta();
  return () => {
    if (ev.SEGMENTATION_DATA_MODIFIED) eventTarget.removeEventListener(ev.SEGMENTATION_DATA_MODIFIED, onData);
    unsubMeta();
    unsubDeleted();
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    void flush();
  };
}

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch((e) => log.warn("mask persistence task failed", e));
  return queue;
}

/**
 * 閉じる・再読み込みの直前: 保留中のデバウンスを止めて、いま送る（ベストエフォート）。
 * 抽出・圧縮が非同期のため、最後の編集からデバウンス時間以内に閉じた分は間に合わない。
 */
export function flushMasksForUnload(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (dirty.size) void flush();
}

/** 保留中のぶんを保存する。 */
export function flush(): Promise<void> {
  return enqueue(async () => {
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) await saveOne(id);
    if (dirty.size) schedule();
  });
}

/** 幾何（行・列・元画像の位置）が引ける＝「前景が無い」を「引けなかった」と取り違えない。 */
function hasGeometry(maskId: string): boolean {
  try {
    const ids = (csSeg as AnyObj).getLabelmapImageIds?.(maskId) as string[] | undefined;
    return !!ids?.length;
  } catch {
    return false;
  }
}

async function saveOne(maskId: string): Promise<void> {
  if (!allMaskIds().includes(maskId)) return; // 保存の前に消えた（一時マスクなど）
  const meta = getRoiMaskMeta(maskId);
  const saved = toSavedMaskMeta(meta);
  const seriesUid = maskSeriesUid(meta);
  if (!meta || !saved || !seriesUid) return;
  const sig = maskMetaSignature(saved);
  const uid = meta.persistUid;

  const frames = extractMaskFrames(maskId);
  if (!frames || countFrames(frames) === 0) {
    // 全部消した（前景が無い）。保存済みなら行を消す。復元できない行を残すと、消したはずの塗りが戻る。
    if (uid && known.has(uid) && hasGeometry(maskId)) {
      try {
        await deleteMask(uid, saved.patientKey);
        known.delete(uid);
        setRoiMaskMeta(maskId, { persistUid: undefined });
        lastSig.set(maskId, sig);
        lastFp.delete(maskId);
      } catch (e) {
        log.warn("mask delete (emptied) failed", uid, e);
      }
    }
    return;
  }

  const pu = uid ?? crypto.randomUUID();
  const fp = contentFingerprint(sig, framesFingerprintInput(frames));
  if (uid && known.has(uid) && lastFp.get(maskId) === fp) {
    lastSig.set(maskId, sig);
    return; // 前回送った内容と同じ（復元直後の通知など）
  }
  const encoded = await encodeFrames(frames);
  const body = {
    patientKey: saved.patientKey,
    seriesUid,
    frameCount: countFrames(frames),
    meta: JSON.stringify(saved),
    frames: encoded,
  };
  let version = known.get(pu)?.version ?? null;
  try {
    let res;
    try {
      res = await saveMask(pu, { ...body, version });
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409) throw e;
      // 別ウィンドウが先に保存した／消した。版を取り直して 1 度だけ再送する（マスクは 1 窓で編集する前提のため後勝ち）。
      const row = (await listMasks(saved.patientKey)).find((r) => r.maskUid === pu);
      version = row?.version ?? null;
      res = await saveMask(pu, { ...body, version });
    }
    known.set(pu, { maskId, version: res.version });
    lastSig.set(maskId, sig);
    lastFp.set(maskId, fp);
    if (!uid) setRoiMaskMeta(maskId, { persistUid: pu });
    failureToasted = false;
  } catch (e) {
    log.warn("mask save failed", maskId, e);
    // 黙って成功にしない。連続して失敗しても通知は 1 回（保存のたびに出さない）。
    if (!failureToasted) {
      failureToasted = true;
      emitToast(tOutsideReact(e instanceof HttpError && e.status === 413 ? "maskPersist.tooLarge" : "maskPersist.saveFailed"));
    }
  }
}

/**
 * 保存済みのマスクのうち、このシリーズのものを表示中のビューポートへ戻す。戻した件数を返す。
 * 解像度が合わない・SOP が解決できないフレームは `importMaskFrames` が捨てるので、
 * 戻した結果のフレーム数を保存時と比べ、減っていれば知らせる。
 */
export async function restoreMasks(patientKey: string, vp: AnyObj): Promise<number> {
  const seriesUid = getViewerContext(vp.id)?.seriesUid;
  if (!patientKey || !seriesUid) return 0;
  let saved;
  try {
    saved = await listMasks(patientKey);
  } catch (e) {
    log.warn("mask list failed", patientKey, e);
    return 0;
  }
  const present = new Set<string>([...known.keys(), ...restoring]);
  for (const id of allMaskIds()) {
    const u = getRoiMaskMeta(id)?.persistUid;
    if (u) present.add(u);
  }
  let restored = 0;
  let lost = 0;
  for (const { summary, meta } of selectMasksToRestore(saved, seriesUid, present)) {
    const uid = summary.maskUid;
    if (restoring.has(uid)) continue;
    restoring.add(uid);
    try {
      const input = await decodeFrames(await fetchMaskFrames(uid));
      if (!input) {
        lost++;
        continue;
      }
      const res = await importMaskFrames(vp, input, meta.label ?? "ROI");
      if (!res) {
        lost++;
        continue;
      }
      const id = res.segmentationId;
      setRoiMaskMeta(id, {
        persistUid: uid,
        patientKey: meta.patientKey,
        ...(meta.label !== undefined ? { label: meta.label } : {}),
        ...(meta.seriesLabel !== undefined ? { seriesLabel: meta.seriesLabel } : {}),
        ...(meta.scope ? { scope: meta.scope } : {}),
        ...(meta.origin ? { origin: meta.origin } : {}),
        ...(meta.groupId ? { groupId: meta.groupId, groupName: meta.groupName } : {}),
        ...(meta.custom ? { custom: meta.custom } : {}),
        ...(meta.segmentLabels ? { segmentLabels: meta.segmentLabels } : {}),
      });
      known.set(uid, { maskId: id, version: summary.version });
      const now = toSavedMaskMeta(getRoiMaskMeta(id));
      const sig = now ? maskMetaSignature(now) : null;
      if (sig) lastSig.set(id, sig);
      restored++;
      const back = extractMaskFrames(id);
      if (!back || countFrames(back) < countFrames(input)) lost++;
      // 復元した内容の指紋を覚える（同じ内容を、復元直後に書き直さない）。
      if (back && sig) lastFp.set(id, contentFingerprint(sig, framesFingerprintInput(back)));
      dirty.delete(id);
    } catch (e) {
      log.warn("mask restore failed", uid, e);
      lost++;
    } finally {
      restoring.delete(uid);
    }
  }
  if (lost > 0) emitToast(tOutsideReact("maskPersist.restorePartial", { n: lost }));
  return restored;
}

/** テスト用: 状態を捨てる。 */
export function resetMaskSaveState(): void {
  known.clear();
  lastSig.clear();
  lastFp.clear();
  dirty.clear();
  restoring.clear();
  if (timer) clearTimeout(timer);
  timer = undefined;
  failureToasted = false;
}
