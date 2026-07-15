/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ウィンドウ間マスク同期（`fw/mask-driven-pipelines-gap-analysis.md` 課題#1）。
 *
 * 2D Viewer / 3D Viewer / Curved MPR 等は `window.open` で別ウィンドウとして起動され、Cornerstone の
 * segmentation（Mask）はウィンドウごとに独立したインメモリ状態のため共有されない。本モジュールは
 * 同一オリジンの `BroadcastChannel` を使い、(1) 他ウィンドウが保持する指定 study/series スコープの
 * マスク一覧の取得（announce）、(2) 選択したマスクのフレームデータ取得（frames）を仲介する。
 * 取得したフレームは `maskFrames.importMaskFrames` で現在ウィンドウの Mask として再構築できる。
 *
 * 各ウィンドウはこのモジュールを import した時点で受信側（サーバ）としても振る舞う（`onmessage` を
 * 即座に登録するため）。要求側（クライアント）としての利用は `requestRemoteMasks`/`requestRemoteMaskFrames`。
 */
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { getRoiMaskMeta } from "./roiMaskStore";
import { extractMaskFrames, type MaskFramesInput } from "./maskFrames";

const CHANNEL_NAME = "graphy-mask-bridge";
const selfId = `w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

interface AnnounceEntry {
  segmentationId: string;
  label: string;
  segmentCount: number;
}
type AnnounceRequest = { type: "announce-request"; requestId: string; studyUid: string; seriesUid: string; from: string };
type AnnounceResponse = { type: "announce-response"; requestId: string; from: string; masks: AnnounceEntry[] };
type FramesRequest = { type: "frames-request"; requestId: string; segmentationId: string; from: string; target: string };
type FramesResponse = { type: "frames-response"; requestId: string; from: string; result: MaskFramesInput | null };
type BridgeMessage = AnnounceRequest | AnnounceResponse | FramesRequest | FramesResponse;

const pending = new Map<string, (msg: AnnounceResponse | FramesResponse) => void>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function localSegmentations(): { segmentationId: string; label?: string }[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((csSeg.state as any).getSegmentations?.() ?? []) as { segmentationId: string; label?: string }[];
  } catch {
    return [];
  }
}

function scopeMatches(segmentationId: string, studyUid: string, seriesUid: string): boolean {
  const scope = getRoiMaskMeta(segmentationId)?.scope;
  return !!scope && scope.studyUid === studyUid && scope.seriesUid === seriesUid;
}

function onMessage(msg: BridgeMessage): void {
  if (msg.from === selfId) return; // 自分自身の送信は無視（同一ウィンドウでも購読される）
  if (msg.type === "announce-request") {
    const masks: AnnounceEntry[] = localSegmentations()
      .filter((s) => scopeMatches(s.segmentationId, msg.studyUid, msg.seriesUid))
      .map((s) => ({
        segmentationId: s.segmentationId,
        label: getRoiMaskMeta(s.segmentationId)?.label ?? s.label ?? s.segmentationId,
        segmentCount: (getRoiMaskMeta(s.segmentationId)?.segments ?? [1]).length,
      }));
    if (masks.length) {
      post({ type: "announce-response", requestId: msg.requestId, from: selfId, masks });
    }
  } else if (msg.type === "frames-request") {
    if (msg.target !== selfId) return;
    if (!localSegmentations().some((s) => s.segmentationId === msg.segmentationId)) return;
    const result = extractMaskFrames(msg.segmentationId);
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

export interface RemoteMask {
  windowId: string;
  segmentationId: string;
  label: string;
  segmentCount: number;
}

/** 他ウィンドウが保持する、指定 study/series スコープのマスク一覧を集める（timeoutMs 待つ）。 */
export function requestRemoteMasks(studyUid: string, seriesUid: string, timeoutMs = 400): Promise<RemoteMask[]> {
  if (!ensureChannel() || !studyUid || !seriesUid) return Promise.resolve([]);
  const requestId = newRequestId();
  const collected: RemoteMask[] = [];
  return new Promise((resolve) => {
    pending.set(requestId, (msg) => {
      if (msg.type !== "announce-response" || msg.requestId !== requestId) return;
      for (const m of msg.masks) {
        collected.push({ windowId: msg.from, segmentationId: m.segmentationId, label: m.label, segmentCount: m.segmentCount });
      }
    });
    post({ type: "announce-request", requestId, studyUid, seriesUid, from: selfId });
    setTimeout(() => {
      pending.delete(requestId);
      resolve(collected);
    }, timeoutMs);
  });
}

/** 指定ウィンドウが持つマスクのフレームデータを取得する（見つからない/タイムアウトなら null）。 */
export function requestRemoteMaskFrames(
  windowId: string,
  segmentationId: string,
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
    post({ type: "frames-request", requestId, segmentationId, from: selfId, target: windowId });
    setTimeout(() => {
      if (done) return;
      done = true;
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
  });
}
