/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「アプリ再起動後に反映される設定」（DICOM 自局 AE のポート/バインドアドレス等）を変更した後、
// 全ウィンドウへ「再起動が必要」を通知するための横断イベント。remoteAeEvents と同じ二重経路
// （BroadcastChannel + localStorage）で、localStorage の値は次回起動まで残る（＝再起動するまで
// バナーが消えない安全側の挙動）。

const CHANNEL = "graphy-restart-required";
const LS_KEY = "graphy-restart-required";

/** 再起動が必要な設定変更があったことを記録し、全ウィンドウへ通知する。 */
export function markRestartRequired(): void {
  try {
    localStorage.setItem(LS_KEY, "1");
  } catch {
    // ストレージ不可は無視
  }
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage("1");
    bc.close();
  } catch {
    // BroadcastChannel 非対応環境は localStorage のみ
  }
}

/** 再起動要求フラグをクリアする（実際に再起動を実行する直前に呼ぶ）。 */
export function clearRestartRequired(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // ストレージ不可は無視
  }
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage("0");
    bc.close();
  } catch {
    // BroadcastChannel 非対応環境は localStorage のみ
  }
}

/** 現在「再起動が必要」フラグが立っているか（初期表示用の同期チェック）。 */
export function isRestartRequired(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

/** 再起動要求フラグの変化を購読する。返り値で解除。 */
export function subscribeRestartRequired(cb: (required: boolean) => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => cb(e.data === "1");
  } catch {
    bc = null;
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_KEY) cb(!!e.newValue);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    bc?.close();
    window.removeEventListener("storage", onStorage);
  };
}
