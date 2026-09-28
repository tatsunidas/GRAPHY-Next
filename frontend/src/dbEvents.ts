/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// DB 変更の横断通知（同一オリジンの別ウィンドウ/タブへ）。
// DbAdmin の編集/削除/統合/分割の後に発火し、別ウィンドウの 2D Viewer 等に「再読込/開き直し」を促す。
// BroadcastChannel を主、localStorage の storage イベントをフォールバックに使う。
// 注: BroadcastChannel は送信元コンテキストには配信されない（同一ウィンドウ内は呼び出し側の
// コールバックで直接処理する想定）。

export interface DbChangedDetail {
  /** 変更種別（"patient-edit" | "study-patient-edit" | "study-delete" | "series-delete" | ...）。 */
  reason: string;
  patientId?: string;
  /** 影響を受けたスタディ（受信側が「当該スタディが利用中か」を判定する手掛かり）。 */
  studyUids?: string[];
  ts: number;
}

const CHANNEL = "graphy-db";
const LS_KEY = "graphy-db-changed";
/** 同じウィンドウの中へ配る印（`includeSelf` のときだけ出す）。 */
const LOCAL_EVENT = "graphy-db-changed-local";

/**
 * DB 変更を他ウィンドウへ通知する。
 *
 * @param opts.includeSelf 送信元のウィンドウにも配る。既定は配らない（呼び出し側が自分で処理する前提）。
 *   プラグインの `db.notifyChanged`（H46）は、呼んだ窓がメイン画面そのものなので、自分の一覧も読み直させる。
 */
export function emitDbChanged(detail: Omit<DbChangedDetail, "ts">, opts: { includeSelf?: boolean } = {}): void {
  const full: DbChangedDetail = { ...detail, ts: Date.now() };
  if (opts.includeSelf) {
    try {
      window.dispatchEvent(new CustomEvent<DbChangedDetail>(LOCAL_EVENT, { detail: full }));
    } catch {
      // 配れなくても他ウィンドウへの通知は続ける
    }
  }
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(full);
    bc.close();
  } catch {
    // BroadcastChannel 非対応環境は localStorage のみ
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(full));
  } catch {
    // ストレージ不可は無視
  }
}

/** DB 変更通知を購読する。返り値で解除。 */
export function subscribeDbChanged(cb: (detail: DbChangedDetail) => void): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => cb(e.data as DbChangedDetail);
  } catch {
    bc = null;
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === LS_KEY && e.newValue) {
      try {
        cb(JSON.parse(e.newValue) as DbChangedDetail);
      } catch {
        // パース失敗は無視
      }
    }
  };
  window.addEventListener("storage", onStorage);
  const onLocal = (e: Event) => cb((e as CustomEvent<DbChangedDetail>).detail);
  window.addEventListener(LOCAL_EVENT, onLocal);
  return () => {
    bc?.close();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCAL_EVENT, onLocal);
  };
}
