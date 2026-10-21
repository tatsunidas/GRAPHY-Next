/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI の「保存が済んだ」通知を窓間で配る（`fw/roi-global-manager.md` G1）。
 *
 * <p>運ぶのは**患者キーだけ**。中身はバックエンド（真実）から受け手が取り直す。
 * 同一オリジンの `BroadcastChannel`。非対応・例外のときは何もしない（保存そのものには影響しない）。
 */
const CHANNEL_NAME = "graphy-roi-changes";

/** テストで差し替えられるよう、必要な面だけを持つ。 */
export interface RoiChannelLike {
  postMessage(msg: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

let selfId = `w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
let channel: RoiChannelLike | null | undefined; // undefined = 未初期化
const listeners = new Set<(patientKey: string) => void>();

function ensure(): RoiChannelLike | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === "undefined" ? null : (new BroadcastChannel(CHANNEL_NAME) as RoiChannelLike);
  } catch {
    channel = null;
  }
  if (channel) channel.onmessage = onMessage;
  return channel;
}

function onMessage(e: { data: unknown }): void {
  const m = e.data as { type?: string; from?: string; patientKey?: string } | null;
  if (!m || m.type !== "roi-saved" || m.from === selfId || typeof m.patientKey !== "string") return;
  for (const l of [...listeners]) {
    try {
      l(m.patientKey);
    } catch {
      /* 1 件の受け手の失敗で他を止めない */
    }
  }
}

/** この窓が患者 `patientKey` の ROI を保存し終えたことを、他の窓へ知らせる。 */
export function announceRoiSaved(patientKey: string): void {
  try {
    ensure()?.postMessage({ type: "roi-saved", from: selfId, patientKey });
  } catch {
    /* 通知できなくても保存は成功している */
  }
}

/** 他の窓の保存通知を聞く。戻り値は解除。 */
export function onRoiSaved(listener: (patientKey: string) => void): () => void {
  ensure();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** テスト用: チャネルと自窓 id を差し替える。null で無効化。 */
export function setRoiChannelForTest(c: RoiChannelLike | null, id = "test-self"): void {
  channel = c;
  selfId = id;
  if (c) c.onmessage = onMessage;
}
