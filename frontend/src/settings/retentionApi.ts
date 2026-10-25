/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 自動削除（standalone のみ。web モードでは 404）。
import { apiBase } from "../apiBase";
import { httpGet, httpSend } from "../http";
import type {
  RetentionConfig,
  RetentionEvent,
  RetentionHold,
  RetentionPreview,
  RetentionRun,
  RetentionStatus,
} from "./retentionView";

const BASE = "/api/dbadmin/retention";

export const fetchRetentionConfig = () => httpGet<RetentionConfig>(`${BASE}/config`);
/** 保存すると、自動削除は無効に戻る（条件を変えたら試算を見せ直すため）。 */
export const saveRetentionConfig = (cfg: RetentionConfig) => httpSend<RetentionConfig>(`${BASE}/config`, "PUT", cfg);
export const fetchRetentionStatus = () => httpGet<RetentionStatus>(`${BASE}/status`);
/** 試算。何も消さない。 */
export const previewRetention = () => httpSend<RetentionPreview>(`${BASE}/preview`, "POST");
export const enableRetention = (previewId: string) => httpSend<RetentionStatus>(`${BASE}/enable`, "POST", { previewId });
export const disableRetention = () => httpSend<RetentionStatus>(`${BASE}/disable`, "POST");
export const runRetentionNow = () => httpSend<RetentionRun>(`${BASE}/run`, "POST");
export const fetchRetentionEvents = (limit = 200) => httpGet<RetentionEvent[]>(`${BASE}/events?limit=${limit}`);
/** まだ見ていない知らせ。無ければ undefined（204）。 */
export const fetchRetentionNotice = () => httpGet<RetentionRun | undefined>(`${BASE}/notice`);
export const ackRetentionNotice = () => httpSend(`${BASE}/notice/ack`, "POST");

export const fetchRetentionHolds = () => httpGet<RetentionHold[]>(`${BASE}/holds`);
export const lockStudy = (studyUid: string) =>
  httpSend<RetentionHold>(`${BASE}/holds/${encodeURIComponent(studyUid)}`, "PUT");
export const unlockStudy = (studyUid: string) =>
  httpSend(`${BASE}/holds/${encodeURIComponent(studyUid)}`, "DELETE");

export const registerStudiesInUse = (studyUids: string[]) =>
  httpSend(`${BASE}/in-use/register`, "POST", { studyUids });
export const releaseStudiesInUse = (studyUids: string[]) =>
  httpSend(`${BASE}/in-use/release`, "POST", { studyUids });

/**
 * ウィンドウを閉じるとき用。`keepalive` の fetch は unload 中でも送れる。
 * （`sendBeacon` は JSON の Blob だと CORS の事前確認が要り、別オリジンの backend へは届かないことがある）
 * 失敗しても何もしない。
 */
export function releaseStudiesBeacon(studyUids: string[]): void {
  try {
    void fetch(`${apiBase()}${BASE}/in-use/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studyUids }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 送れなくても閉じる
  }
}
