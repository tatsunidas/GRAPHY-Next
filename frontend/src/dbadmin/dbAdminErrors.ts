/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DB 管理の操作が失敗したときの、利用者向けの文言。
 * backend の理由コードを、読める文に写す（それ以外は従来どおり例外の文字列）。
 */
import { HttpError } from "../http";
import { storageReasonKey } from "../storageUnavailable";
import type { TFn } from "../i18n/i18n";

export function friendlyDbAdminError(e: unknown, t: TFn): string {
  if (e instanceof HttpError) {
    // 患者編集: ファイルの書き換えに 1 つでも失敗したら、全体が取り消され何も変わっていない
    if (e.status === 409 && e.message.startsWith("patient-edit-failed")) return t("dbadmin.error.patientEditFailed");
    // モード A: 手元に無い画像を Drive から取り寄せられなかった
    if (e.status === 503) return t(storageReasonKey(e.message));
  }
  return String(e);
}
