/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * タスク・ランチャー → 2D ビューアへの「このシリーズでこの解析を開け」の受け渡し
 * （`fw/angio-design.md` §21.2・A13-2）。
 *
 * <h3>なぜ専用の経路が要るか</h3>
 * ランチャーはメインウィンドウ、解析ダイアログは **2D ビューアのウィンドウ**にある。
 * シリーズを開く経路（`localStorage["graphy-viewer-ctx"]`）は既にあるが、
 * **「開いた上で何をするか」は運べない**。
 *
 * <p>⚠️ **依頼を `localStorage` に置かない。** ビューアのコンテキストと違って、これは
 * **一度使ったら消える指示**である。localStorage に置くと automator の実行を跨いで残り、
 * 次に 2D ビューアを開いただけで解析ダイアログが勝手に開く
 * （`automator-verification-hygiene` の既知の罠）。`BroadcastChannel` ＋ 送り手の
 * メモリ上の保持にする（`analysisResultStore` と同じ作法）。
 *
 * <h3>取りこぼしと取り違えを防ぐ 3 つの仕掛け</h3>
 * 1. **保留と引き取り（pull）**。ビューアのウィンドウはまだ存在しないことがあるので、
 *    送り手が依頼を保持し、ビューア側がマウント時に `pull` で取りに来る。
 * 2. **宛先の一致を受け手が判定する**（{@link matchesRequest}）。タイルは複数開けるので、
 *    **依頼したのとは別のシリーズで解析ダイアログが開く**のが最悪の失敗になる。
 * 3. **時間切れ**（{@link isFreshRequest}）。誰も引き取らなかった依頼が残っていると、
 *    10 分後にビューアを開いた人にダイアログが降ってくる。古い依頼は捨てる。
 */

import { type AnalysisTaskTarget } from "./xaTaskCatalog";

/** ビューア側で開くもの。`report` はメインウィンドウ側で完結するのでここには来ない。 */
export type XaTaskTarget = Exclude<AnalysisTaskTarget, "report">;

export interface XaTaskRequest {
  /** 依頼の一意な識別子（引き取り済みの通知に使う）。 */
  id: string;
  target: XaTaskTarget;
  studyUid: string;
  seriesUid: string;
  /** 発行時刻（epoch ms）。 */
  at: number;
}

/** 依頼の有効期限。これを過ぎた依頼は引き取らない。 */
export const XA_TASK_TTL_MS = 60_000;

export function isFreshRequest(req: XaTaskRequest, now: number): boolean {
  // 未来の時刻（時計のずれ）も弾く。信用できない依頼で勝手にダイアログを開かない。
  return now >= req.at && now - req.at <= XA_TASK_TTL_MS;
}

/**
 * この依頼が自分（このタイル）宛かどうか。
 *
 * <p>🚨 **スタディとシリーズの両方**で判定する。シリーズ UID は原則一意だが、
 * 取り込み元が違うデータで衝突した実例があるため、片方だけで判定しない。
 */
export function matchesRequest(req: XaTaskRequest, tile: { studyUid: string; seriesUid: string }): boolean {
  return req.studyUid === tile.studyUid && req.seriesUid === tile.seriesUid;
}

// ── 配信 ────────────────────────────────────────────────────────────────

const CHANNEL = "graphy-xa-task-launch";

type Msg =
  | { type: "request"; req: XaTaskRequest }
  | { type: "pull" }
  | { type: "consumed"; id: string };

let channel: BroadcastChannel | null = null;
/** 送り手が保持する未引き取りの依頼（1 つだけ。連続で押したら新しいほうが正しい）。 */
let pending: XaTaskRequest | null = null;
const listeners = new Set<(req: XaTaskRequest) => void>();

function post(msg: Msg): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* 非対応環境では単一ウィンドウとして動く */
  }
}

function deliver(req: XaTaskRequest): void {
  for (const l of [...listeners]) {
    try {
      l(req);
    } catch {
      /* 受け手の失敗で他の受け手を巻き込まない */
    }
  }
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
    return;
  }
  channel.onmessage = (e) => {
    const msg = e.data as Msg;
    if (msg.type === "request") deliver(msg.req);
    else if (msg.type === "pull" && pending) post({ type: "request", req: pending });
    else if (msg.type === "consumed" && pending?.id === msg.id) pending = null;
  };
}

/** ランチャーから呼ぶ。依頼を配り、引き取られるまで保持する。 */
export function requestXaTask(req: XaTaskRequest): void {
  ensureChannel();
  pending = req;
  post({ type: "request", req });
  // 同一ウィンドウ内の受け手にも届ける（web モードでビューアがハッシュ遷移の同一タブにいる場合）。
  deliver(req);
}

/** ビューア側から呼ぶ。未引き取りの依頼があれば送り手が投げ直す。 */
export function pullXaTask(): void {
  ensureChannel();
  post({ type: "pull" });
}

/** 引き取った（＝ダイアログを開いた）ことを送り手に伝える。二度開かないために要る。 */
export function consumeXaTask(id: string): void {
  ensureChannel();
  if (pending?.id === id) pending = null;
  post({ type: "consumed", id });
}

/**
 * 依頼を受け取る。**受け手側で宛先と鮮度を判定してから**呼び出される。
 *
 * @returns 購読解除
 */
export function onXaTaskRequest(cb: (req: XaTaskRequest) => void): () => void {
  ensureChannel();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** テスト用。モジュール状態を捨てる。 */
export function resetXaTaskLaunch(): void {
  pending = null;
  listeners.clear();
}

/** テスト用。保留中の依頼。 */
export function pendingXaTask(): XaTaskRequest | null {
  return pending;
}
