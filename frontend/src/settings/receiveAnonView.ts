/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 受信時の匿名化の表示用の純関数（画面から切り離してテストする）。

import type { AnonOption } from "../api";

export interface ReceiveAnonProfile {
  options: string[];
  patientIdPrefix: string | null;
  patientName: string | null;
  manualRetainTags: string[];
  customReplacements: Record<string, string>;
}

export interface ReceiveAnonStatus {
  enabled: boolean;
  profileValid: boolean;
  keyCreatedAt: string | null;
  keyCreatedThisRun: boolean;
  accepted: number;
  rejected: number;
  recentRejections: string[];
}

/** `GET /api/dicom/receive-anonymize`。profile は設定が読めないとき null。 */
export interface ReceiveAnonView {
  enabled: boolean;
  profile: ReceiveAnonProfile | null;
  status: ReceiveAnonStatus;
}

export const DEFAULT_PREFIX = "ANON-";
/** backend の上限（UID 64 文字の ID のうち、仮名の 10 桁を除く）。 */
export const MAX_PREFIX = 54;

/**
 * 受信時に選べるオプション。画素の消去（CleanPixelData）は受信時には行わないので出さない
 * ——選べると「消した」と誤解させる。
 */
export const RECEIVE_RETAIN_OPTS: AnonOption[] = [
  "RetainSafePrivate", "RetainDeviceIdentity", "RetainInstitutionIdentity", "RetainPatientCharacteristics",
  "RetainLongitudinalTemporalInformationFullDates", "RetainLongitudinalTemporalInformationModifiedDates",
];
export const RECEIVE_CLEAN_OPTS: AnonOption[] = ["CleanGraphics", "CleanStructuredContent", "CleanDescriptors"];
/** 画面に出さないオプション（既存の設定に入っていても保存時に落とさず、そのまま送り返す）。 */
export function hiddenOptions(options: string[]): string[] {
  const shown = new Set<string>([...RECEIVE_RETAIN_OPTS, ...RECEIVE_CLEAN_OPTS]);
  // CleanPixelData は受信時には実現できず backend が拒否する。送り返すと既存の設定が画面から直せなくなるので落とす。
  return options.filter((o) => !shown.has(o) && o !== "CleanPixelData");
}

export type BarTone = "ok" | "warn" | "error";

export interface ReceiveAnonBar {
  visible: boolean;
  tone: BarTone;
  accepted: number;
  rejected: number;
}

/** メイン画面の帯。無効・取得できない（web モードの 404 など）ときは出さない。 */
export function barView(v: ReceiveAnonView | null): ReceiveAnonBar {
  if (!v || !v.enabled) return { visible: false, tone: "ok", accepted: 0, rejected: 0 };
  const { status } = v;
  const tone: BarTone = !status.profileValid ? "error" : status.rejected > 0 ? "warn" : "ok";
  return { visible: true, tone, accepted: status.accepted, rejected: status.rejected };
}

/** backend の拒否理由コード → i18n キー。コードは固定の短い語（元の値は含まれない）。 */
export function rejectReasonKey(code: string): string {
  if (code === "burned-in-annotation") return "recvAnon.reason.burned";
  if (code === "burn-prone-modality") return "recvAnon.reason.modality";
  if (code.startsWith("failed:")) return "recvAnon.reason.failed";
  return "recvAnon.reason.unknown";
}

/** 保存前の検査。問題があれば i18n キー、無ければ null。 */
export function validateForm(f: { enabled: boolean; wasEnabled: boolean; confirmed: boolean; prefix: string }): string | null {
  if (f.prefix.length > MAX_PREFIX) return "recvAnon.err.prefixLong";
  // 無効から有効へ変えるときだけ、注意を読んだことの確認を求める（すでに有効なら設定変更のたびには求めない）。
  if (f.enabled && !f.wasEnabled && !f.confirmed) return "recvAnon.err.confirm";
  return null;
}

/** 保存する本文。画面に出さない項目（保持タグ・置換・非表示のオプション。CleanPixelData は除く）は読んだ値をそのまま送る。 */
export function buildBody(
  base: ReceiveAnonProfile | null,
  shownOptions: string[],
  prefix: string,
  patientName: string,
): ReceiveAnonProfile {
  return {
    options: [...shownOptions, ...hiddenOptions(base?.options ?? [])],
    patientIdPrefix: prefix === "" ? DEFAULT_PREFIX : prefix,
    patientName: patientName.trim() === "" ? null : patientName.trim(),
    manualRetainTags: base?.manualRetainTags ?? [],
    customReplacements: base?.customReplacements ?? {},
  };
}
