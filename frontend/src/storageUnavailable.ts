/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モード A（Drive が正本）で、手元に無い画像を取り寄せられなかったときの理由。
 * backend は「その画像は無い」（404）と区別して 503 と理由コードを返す（`StorageUnavailableException`）。
 */
const REASONS = ["offline", "needs-login", "drive-disabled", "md5-mismatch", "no-checksum", "not-on-drive", "drive-error"];

/** 理由コード → 文言のキー（未知のコードは汎用の文言）。 */
export function storageReasonKey(reason: string | null | undefined): string {
  return reason && REASONS.includes(reason) ? `storage.unavailable.${reason}` : "storage.unavailable.unknown";
}
