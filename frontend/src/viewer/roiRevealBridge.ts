/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 別ウィンドウ（ROI 特徴量の画面など）から、2D ビューアのウィンドウへ「このスライスを見せて」を届ける橋。
 *
 * <p>`roiReveal.ts` のバスは同一ウィンドウの中だけに届く。ここでは BroadcastChannel（同一オリジンの別ウィンドウ）で
 * 要求を送り、受け手のウィンドウが**そのシリーズを開いているタイルを持つときだけ**応答（ack）を返す。
 * 送り手は一定時間 ack が無ければ「開いているビューアが無い」と判断できる（押しても何も起きない、にしない）。
 */
import { emitRoiReveal, hasRevealSeries, type RoiRevealRequest } from "./roiReveal";
import { isSliceNavigationLocked } from "./sliceNavigationLock";
import { emitToast } from "./toast";

const CHANNEL = "graphy-roi-reveal";

interface RevealMsg {
  type: "reveal";
  id: string;
  req: RoiRevealRequest;
  /** 受け手のトーストに出す文（送り手が i18n 済みで渡す）。 */
  toast?: string;
}
interface AckMsg {
  type: "ack";
  id: string;
  /** 解析中でスライス送りが錠で止められていて、移せなかった。 */
  locked: boolean;
}

/** ok=移した／none=開いているビューアが無い／locked=解析中で移せない。 */
export type RevealOutcome = "ok" | "none" | "locked";

/** timeoutMs の間に誰も受けなければ "none"。 */
export function requestRemoteReveal(req: RoiRevealRequest, toast?: string, timeoutMs = 1000): Promise<RevealOutcome> {
  return new Promise((resolve) => {
    let bc: BroadcastChannel;
    try {
      bc = new BroadcastChannel(CHANNEL);
    } catch {
      resolve("none");
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const done = (r: RevealOutcome) => {
      window.clearTimeout(timer);
      bc.close();
      resolve(r);
    };
    const timer = window.setTimeout(() => done("none"), timeoutMs);
    bc.onmessage = (ev: MessageEvent<AckMsg>) => {
      if (ev.data?.type === "ack" && ev.data.id === id) done(ev.data.locked ? "locked" : "ok");
    };
    const msg: RevealMsg = { type: "reveal", id, req, toast };
    bc.postMessage(msg);
  });
}

/** ビューアのウィンドウで 1 回だけ呼ぶ。返り値は解除関数。 */
export function installRoiRevealReceiver(): () => void {
  let bc: BroadcastChannel;
  try {
    bc = new BroadcastChannel(CHANNEL);
  } catch {
    return () => {};
  }
  bc.onmessage = (ev: MessageEvent<RevealMsg>) => {
    const m = ev.data;
    if (m?.type !== "reveal") return;
    // シリーズ指定が無い要求、または自分のタイルが持たないシリーズは受けない（他ウィンドウに任せる）
    if (!m.req.seriesUid || !hasRevealSeries(m.req.seriesUid)) return;
    const locked = isSliceNavigationLocked();
    if (!locked) {
      emitRoiReveal(m.req);
      if (m.toast) emitToast(m.toast);
    }
    bc.postMessage({ type: "ack", id: m.id, locked } satisfies AckMsg);
  };
  return () => bc.close();
}
