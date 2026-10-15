/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ウィンドウ間マスク同期（`fw/mask-driven-pipelines-gap-analysis.md` 課題#1）。
 *
 * 2D Viewer / 3D Viewer / Curved MPR 等は `window.open` で別ウィンドウとして起動され、Cornerstone の
 * segmentation（Mask）はウィンドウごとに独立したインメモリ状態のため共有されない。本モジュールは
 * 同一オリジンの `BroadcastChannel` を使い、(1) 他ウィンドウが保持する指定 study/series/C/T スコープの
 * ROI 一覧（塗りは segment 単位・パラメトリック球）の取得（announce）、(2) 選択したマスクのフレームデータ取得（frames）を仲介する。
 * 取得したフレームは `maskFrames.importMaskFrames` で現在ウィンドウの Mask として再構築できる。
 *
 * 各ウィンドウはこのモジュールを import した時点で受信側（サーバ）としても振る舞う（`onmessage` を
 * 即座に登録するため）。要求側（クライアント）としての利用は `requestRemoteMasks`/`requestRemoteMaskFrames`。
 */
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { getRoiMaskMeta, getMaskSegments } from "./roiMaskStore";
import { extractMaskFrames, type MaskFramesInput } from "./maskFrames";
import { listSpheres3D } from "./sphere3dStore";
import { buildAnnounceEntries, type AnnounceEntry, type AnnounceQuery } from "./maskBridgeCore";

export type { AnnounceEntry, AnnounceQuery } from "./maskBridgeCore";

const CHANNEL_NAME = "graphy-mask-bridge";
const selfId = `w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

type AnnounceRequest = ({ type: "announce-request"; requestId: string; from: string }) & AnnounceQuery;
type AnnounceResponse = { type: "announce-response"; requestId: string; from: string; rois: AnnounceEntry[] };
type FramesRequest = {
  type: "frames-request";
  requestId: string;
  segmentationId: string;
  /** 指定時はその segment だけを抽出する。 */
  segmentIndex?: number;
  from: string;
  target: string;
};
type FramesResponse = { type: "frames-response"; requestId: string; from: string; result: MaskFramesInput | null };
type BridgeMessage = AnnounceRequest | AnnounceResponse | FramesRequest | FramesResponse;

const pending = new Map<string, (msg: AnnounceResponse | FramesResponse) => void>();

function localSegmentations(): { segmentationId: string; label?: string }[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((csSeg.state as any).getSegmentations?.() ?? []) as { segmentationId: string; label?: string }[];
  } catch {
    return [];
  }
}

/** segment の表示色（0..255）。ビューポートに載っていない等で引けなければ null。 */
function segmentColor255(segmentationId: string, segmentIndex: number): [number, number, number] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = ((csSeg.state as any).getViewportIdsWithSegmentation?.(segmentationId) as string[] | undefined)?.[0];
    if (!vp) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (csSeg.config.color as any).getSegmentIndexColor(vp, segmentationId, segmentIndex) as number[] | undefined;
    return c && c.length >= 3 ? [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])] : null;
  } catch {
    return null;
  }
}

/** このウィンドウが持つ ROI（塗りの segment 単位 + パラメトリック球）を、3D のコンテキストで絞って返す。 */
export function collectLocalRois(q: AnnounceQuery): AnnounceEntry[] {
  return buildAnnounceEntries(q, {
    segmentations: localSegmentations(),
    metaOf: getRoiMaskMeta,
    segmentsOf: getMaskSegments,
    colorOf: segmentColor255,
    spheres: listSpheres3D().map((s) => ({
      id: s.id,
      studyUid: s.studyUid,
      seriesUid: s.seriesUid,
      center: s.center,
      radiusMm: s.radiusMm,
      c: s.c,
      t: s.t,
      label: s.label,
      color: s.color,
    })),
  });
}

function onMessage(msg: BridgeMessage): void {
  if (msg.from === selfId) return; // 自分自身の送信は無視（同一ウィンドウでも購読される）
  if (msg.type === "announce-request") {
    const rois = collectLocalRois(msg);
    if (rois.length) {
      post({ type: "announce-response", requestId: msg.requestId, from: selfId, rois });
    }
  } else if (msg.type === "frames-request") {
    if (msg.target !== selfId) return;
    if (!localSegmentations().some((s) => s.segmentationId === msg.segmentationId)) return;
    const result = extractMaskFrames(msg.segmentationId, msg.segmentIndex);
    post({ type: "frames-response", requestId: msg.requestId, from: selfId, result });
  } else if (msg.type === "announce-response" || msg.type === "frames-response") {
    pending.get(msg.requestId)?.(msg);
  }
}

let channel: BroadcastChannel | null = null;
function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (ev: MessageEvent<BridgeMessage>) => onMessage(ev.data);
  return channel;
}
function post(msg: BridgeMessage): void {
  ensureChannel()?.postMessage(msg);
}
// import 時点で受信側として即座に待ち受ける（他ウィンドウからの announce/frames 要求に応答するため）。
ensureChannel();

function newRequestId(): string {
  return `${selfId}-${Math.random().toString(36).slice(2)}`;
}

export type RemoteRoi = AnnounceEntry & { windowId: string };

/** 他ウィンドウが保持する、指定 study/series/C/T の ROI 一覧を集める（timeoutMs 待つ）。 */
export function requestRemoteRois(q: AnnounceQuery, timeoutMs = 400): Promise<RemoteRoi[]> {
  if (!ensureChannel() || !q.studyUid || !q.seriesUid) return Promise.resolve([]);
  const requestId = newRequestId();
  const collected: RemoteRoi[] = [];
  return new Promise((resolve) => {
    pending.set(requestId, (msg) => {
      if (msg.type !== "announce-response" || msg.requestId !== requestId) return;
      for (const r of msg.rois) collected.push({ ...r, windowId: msg.from });
    });
    post({ type: "announce-request", requestId, from: selfId, studyUid: q.studyUid, seriesUid: q.seriesUid, c: q.c, t: q.t });
    setTimeout(() => {
      pending.delete(requestId);
      resolve(collected);
    }, timeoutMs);
  });
}

/** 指定ウィンドウが持つマスクのフレームデータを取得する（`segmentIndex` 指定でその segment のみ。見つからない/タイムアウトなら null）。 */
export function requestRemoteMaskFrames(
  windowId: string,
  segmentationId: string,
  segmentIndex?: number,
  timeoutMs = 8000,
): Promise<MaskFramesInput | null> {
  if (!ensureChannel()) return Promise.resolve(null);
  const requestId = newRequestId();
  return new Promise((resolve) => {
    let done = false;
    pending.set(requestId, (msg) => {
      if (msg.type !== "frames-response" || msg.requestId !== requestId || done) return;
      done = true;
      pending.delete(requestId);
      resolve(msg.result);
    });
    post({ type: "frames-request", requestId, segmentationId, segmentIndex, from: selfId, target: windowId });
    setTimeout(() => {
      if (done) return;
      done = true;
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
  });
}
