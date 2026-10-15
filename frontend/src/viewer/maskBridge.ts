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
import { annotation as csAnnotation, segmentation as csSeg } from "@cornerstonejs/tools";
import { getRoiMaskMeta, getMaskSegments } from "./roiMaskStore";
import { extractMaskFrames, type MaskFramesInput } from "./maskFrames";
import { listSpheres3D } from "./sphere3dStore";
import { buildAnnounceEntries, type AnnounceEntry, type AnnounceQuery, type AnnounceShapeInput } from "./maskBridgeCore";
import { withTempMask } from "./roiBooleanOps";

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
  /** 形の ROI のとき。一時的に塗りへ変えて抽出する（`segmentationId` は使わない）。 */
  annotationUid?: string;
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

/** "rgb(r, g, b)" / "rgba(...)" / "#rrggbb" → [r,g,b]。読めなければ null。 */
function cssColor255(c: unknown): [number, number, number] | null {
  if (typeof c !== "string") return null;
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
  return h ? [parseInt(h[1], 16), parseInt(h[2], 16), parseInt(h[3], 16)] : null;
}

function localShapes(): AnnounceShapeInput[] {
  let anns: unknown[] = [];
  try {
    anns = (csAnnotation.state.getAllAnnotations() as unknown[]) ?? [];
  } catch {
    return [];
  }
  const out: AnnounceShapeInput[] = [];
  for (const a of anns) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ann = a as any;
    const uid = ann?.annotationUID as string | undefined;
    if (!uid) continue;
    let color: [number, number, number] | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      color = cssColor255((csAnnotation.config.style as any).getAnnotationToolStyles?.(uid)?.color);
    } catch {
      /* ignore */
    }
    out.push({
      annotationUid: uid,
      toolName: ann?.metadata?.toolName ?? "",
      closed: ann?.data?.contour?.closed,
      meta: getRoiMaskMeta(uid),
      color,
    });
  }
  return out;
}

/** このウィンドウが持つ ROI（塗りの segment 単位・面積型の形の ROI・パラメトリック球）を、3D のコンテキストで絞って返す。 */
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
    shapes: localShapes(),
  });
}

/** 形の ROI を一時的に塗りへ変えて、フレームを取り出す（終わったら一時の塗りは消える）。 */
export function extractShapeFrames(annotationUid: string): Promise<MaskFramesInput | null> {
  return withTempMask(annotationUid, (tmp) => extractMaskFrames(tmp));
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
    if (msg.annotationUid) {
      const { requestId } = msg;
      void extractShapeFrames(msg.annotationUid)
        .catch(() => null)
        .then((result) => post({ type: "frames-response", requestId, from: selfId, result }));
      return;
    }
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

/**
 * 指定ウィンドウが持つマスクのフレームデータを取得する（`segmentIndex` 指定でその segment のみ。見つからない/タイムアウトなら null）。
 * `annotationUid` を渡すと、その形の ROI を相手側で一時的に塗りへ変えて取り出す。
 */
export function requestRemoteMaskFrames(
  windowId: string,
  segmentationId: string,
  segmentIndex?: number,
  timeoutMs = 8000,
  annotationUid?: string,
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
    post({ type: "frames-request", requestId, segmentationId, segmentIndex, annotationUid, from: selfId, target: windowId });
    setTimeout(() => {
      if (done) return;
      done = true;
      pending.delete(requestId);
      resolve(null);
    }, timeoutMs);
  });
}
