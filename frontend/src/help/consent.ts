/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 起動時の利用条件（研究用・非診断）への同意の判定と記録。
// 記録は設定ストア（PUT /api/settings）に版つきで置く。同意文を改めたら CONSENT_VERSION を上げると、
// 古い版で同意した利用者にだけ再び出る。設定を書けない公開デモ機は sessionStorage に持ち、1 セッション 1 回だけ出す。

export const CONSENT_VERSION = 1;
export const CONSENT_KEY = "legal.researchUseConsent";

/** 同意が要るか。未設定・壊れた値・古い版は true。 */
export function needsConsent(raw: string | undefined | null, current: number = CONSENT_VERSION): boolean {
  if (!raw) return true;
  try {
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v !== "number" || !Number.isFinite(v) || v < current;
  } catch {
    return true;
  }
}

export function consentRecord(now: Date = new Date()): string {
  return JSON.stringify({ version: CONSENT_VERSION, acceptedAt: now.toISOString() });
}

export function readSessionConsent(): string | null {
  try {
    return sessionStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

export function writeSessionConsent(raw: string): void {
  try {
    sessionStorage.setItem(CONSENT_KEY, raw);
  } catch {
    /* sessionStorage 不可の環境では、次の読み込みでまた出るだけ */
  }
}
