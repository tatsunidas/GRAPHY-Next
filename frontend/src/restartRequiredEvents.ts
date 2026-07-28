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

/**
 * 再起動が必要になった理由。バナーの文言を切り替えるために使う
 * （DICOM の文言をプラグインに流用すると誤案内になる）。
 */
export type RestartReason = "dicom" | "plugin";

/**
 * 保存値/通知値 → 理由。解除の合図（{@code "0"}・null・空）は null を返す。
 * 旧形式の {@code "1"} は DICOM 設定として扱う（後方互換）。
 */
function toReason(value: string | null): RestartReason | null {
  switch (value) {
    case "plugin":
      return "plugin";
    case "dicom":
    case "1":
      return "dicom";
    default:
      return null; // "0"（解除）・null・未知の値
  }
}

/** 再起動が必要な変更があったことを記録し、全ウィンドウへ通知する。 */
export function markRestartRequired(reason: RestartReason = "dicom"): void {
  try {
    localStorage.setItem(LS_KEY, reason);
  } catch {
    // ストレージ不可は無視
  }
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(reason);
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

/**
 * 現在の再起動要求（初期表示用の同期チェック）。不要なら null。
 * 返る値がそのままバナーの文言選択に使われる。
 */
export function restartRequiredReason(): RestartReason | null {
  try {
    return toReason(localStorage.getItem(LS_KEY));
  } catch {
    return null;
  }
}

/** 再起動要求の変化を購読する（不要になったら null が渡る）。返り値で解除。 */
export function subscribeRestartRequired(cb: (reason: RestartReason | null) => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => cb(toReason(typeof e.data === "string" ? e.data : null));
  } catch {
    bc = null;
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_KEY) cb(toReason(e.newValue));
  };
  window.addEventListener("storage", onStorage);
  return () => {
    bc?.close();
    window.removeEventListener("storage", onStorage);
  };
}
