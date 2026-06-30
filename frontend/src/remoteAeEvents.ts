/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 送信先 Remote AE（QR Destination）変更の横断通知（同一オリジンの別ウィンドウ/タブへ）。
// Settings の RemoteAePanel で送信先を追加/編集/削除した後に発火し、QR ウィンドウに
// 「全タブを再構築（再 Echo→通ったものだけタブ化）」を促す。dbEvents と同じ二重経路。

const CHANNEL = "graphy-remote-aes";
const LS_KEY = "graphy-remote-aes-changed";

/** 送信先 Remote AE の変更を他ウィンドウへ通知する。 */
export function emitRemoteAesChanged(): void {
  const payload = JSON.stringify({ ts: Date.now() });
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(payload);
    bc.close();
  } catch {
    // BroadcastChannel 非対応環境は localStorage のみ
  }
  try {
    localStorage.setItem(LS_KEY, payload);
  } catch {
    // ストレージ不可は無視
  }
}

/** 送信先 Remote AE 変更通知を購読する。返り値で解除。 */
export function subscribeRemoteAesChanged(cb: () => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => cb();
  } catch {
    bc = null;
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_KEY && e.newValue) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    bc?.close();
    window.removeEventListener("storage", onStorage);
  };
}
