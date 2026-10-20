/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 共有リンクの受け手の画面状態。応答の読み方だけを切り出した純関数（画面から独立して試せる）。
// 無効・期限切れ・取り消しは backend が 404 に揃えている（理由を区別しない）ので、画面も区別しない。

import { HttpError } from "../http";
import type { Study } from "../api";

export type ShareState =
  | { kind: "ready"; study: Study }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

/** `GET /api/share/study` の結果（配列）から画面状態を決める。許可は検査 1 件が前提だが、先頭だけを使う。 */
export function shareStateFromStudies(studies: Study[] | null | undefined): ShareState {
  return studies && studies.length > 0 ? { kind: "ready", study: studies[0] } : { kind: "invalid" };
}

/** 取得失敗から画面状態を決める。404（と 401・403）は「無効なリンク」、それ以外は通信などの失敗。 */
export function shareStateFromError(e: unknown): ShareState {
  if (e instanceof HttpError && (e.status === 404 || e.status === 401 || e.status === 403)) {
    return { kind: "invalid" };
  }
  return { kind: "error", message: e instanceof Error ? e.message : String(e) };
}
