/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 環境設定 ＞ 自動削除の表示用の純関数（画面から切り離してテストする）。

/** 条件。null は「その条件を使わない」。値の既定は無い（利用者が決める）。 */
export interface RetentionConfig {
  days: number | null;
  maxGb: number | null;
  minFreeGb: number | null;
}

export interface RetentionRun {
  id: string;
  at: string | number;
  trigger: string;
  planned: number;
  deleted: number;
  partial: number;
  failed: number;
  skipped: number;
  bytesFreed: number;
  satisfied: boolean;
  /** 警告のコード（カンマ区切り）。例: free, protected:3, aborted。 */
  warnings: string | null;
}

export interface RetentionStatus {
  diskTotalBytes: number;
  diskFreeBytes: number;
  storeBytes: number;
  studies: number;
  largestStudyBytes: number;
  maxDailyIntakeBytes: number | null;
  recordedDays: number;
  lockedStudies: number;
  enabled: boolean;
  firstRunPending: boolean;
  cacheMode: boolean;
  lastRun: RetentionRun | null;
}

export interface RetentionPlanItem {
  studyUid: string;
  patientId: string | null;
  patientName: string | null;
  studyDate: string | null;
  modality: string | null;
  instances: number;
  sizeBytes: number;
  lastReceivedAt: number;
  /** days / size / free */
  reason: string;
}

export interface RetentionPlan {
  items: RetentionPlanItem[];
  totalBytes: number;
  /** 保護の理由 → 除外された検査数。 */
  protectedSkips: Record<string, number>;
  satisfied: boolean;
  warnings: string[];
}

export interface RetentionPreview {
  previewId: string;
  plan: RetentionPlan;
}

export interface RetentionEvent {
  id: string;
  runId: string;
  at: string | number;
  studyUid: string;
  patientId: string | null;
  patientName: string | null;
  studyDate: string | null;
  modality: string | null;
  instances: number;
  sizeBytes: number;
  reason: string | null;
  /** deleted / partial / failed / skipped */
  result: string;
  failedFiles: number;
  errorKind: string | null;
}

export interface RetentionHold {
  studyUid: string;
  lockedAt: string;
  studyExists: boolean;
}

/** 入力欄。数値は文字列のまま持つ（空は未入力）。 */
export interface RetentionForm {
  daysOn: boolean;
  days: string;
  maxOn: boolean;
  maxGb: string;
  freeOn: boolean;
  minFreeGb: string;
}

export type FieldKey = "days" | "maxGb" | "minFreeGb";

export function formFromConfig(c: RetentionConfig): RetentionForm {
  return {
    daysOn: c.days != null,
    days: c.days != null ? String(c.days) : "",
    maxOn: c.maxGb != null,
    maxGb: c.maxGb != null ? String(c.maxGb) : "",
    freeOn: c.minFreeGb != null,
    minFreeGb: c.minFreeGb != null ? String(c.minFreeGb) : "",
  };
}

function positiveNumber(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positiveInt(s: string): number | null {
  const n = positiveNumber(s);
  return n != null && Number.isInteger(n) ? n : null;
}

/** 入力に誤りがある欄（オンなのに値が正でない）。 */
export function invalidFields(f: RetentionForm): FieldKey[] {
  const bad: FieldKey[] = [];
  if (f.daysOn && positiveInt(f.days) == null) bad.push("days");
  if (f.maxOn && positiveNumber(f.maxGb) == null) bad.push("maxGb");
  if (f.freeOn && positiveNumber(f.minFreeGb) == null) bad.push("minFreeGb");
  return bad;
}

/** 条件が 1 つ以上あり、すべて正しいときだけ true。 */
export function canApplyForm(f: RetentionForm): boolean {
  return (f.daysOn || f.maxOn || f.freeOn) && invalidFields(f).length === 0;
}

/** オフの欄は null。呼ぶ前に {@link canApplyForm} を確かめる。 */
export function configFromForm(f: RetentionForm): RetentionConfig {
  return {
    days: f.daysOn ? positiveInt(f.days) : null,
    maxGb: f.maxOn ? positiveNumber(f.maxGb) : null,
    minFreeGb: f.freeOn ? positiveNumber(f.minFreeGb) : null,
  };
}

export function sameConfig(a: RetentionConfig, b: RetentionConfig): boolean {
  return a.days === b.days && a.maxGb === b.maxGb && a.minFreeGb === b.minFreeGb;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** 容量の表示（GB は 1024³）。 */
export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function formatTime(v: string | number | null | undefined): string {
  if (v == null) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function reasonKey(code: string | null | undefined): string {
  return code === "days" || code === "size" || code === "free" ? `retention.reason.${code}` : "retention.reason.unknown";
}

const PROTECTIONS = [
  "lock",
  "roi",
  "report",
  "registration",
  "glam",
  "xaCalibration",
  "pluginRecord",
  "inUse",
  "receivedAfterPlanStart",
  "unknownReceived",
  "nonImageDicom",
];

export function protectionKey(code: string): string {
  return PROTECTIONS.includes(code) ? `retention.protect.${code}` : "retention.protect.unknown";
}

/** 結果 → 文言キー。未知は汎用。 */
export function resultKey(code: string): string {
  return ["deleted", "partial", "failed", "skipped"].includes(code) ? `retention.result.${code}` : "retention.result.unknown";
}

export function resultColor(code: string): string {
  if (code === "failed") return "#b00020";
  if (code === "partial") return "#8a5a00";
  if (code === "skipped") return "#667";
  return "#1b6e2f";
}

/** 警告コード（"free" / "size" / "protected:3" / "aborted" / "cache-mode-unsupported"）→ 文言。 */
export function warningView(code: string): { key: string; n?: number } {
  if (code.startsWith("protected:")) {
    const n = Number(code.slice("protected:".length));
    return { key: "retention.warn.protected", n: Number.isFinite(n) ? n : undefined };
  }
  if (["free", "size", "aborted", "cache-mode-unsupported"].includes(code)) return { key: `retention.warn.${code}` };
  return { key: "retention.warn.unknown" };
}

export function splitWarnings(w: string | null | undefined): string[] {
  return w ? w.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** 保護で除外した検査の合計（理由別の合計ではなく、表示用の目安）。 */
export function protectedSummary(skips: Record<string, number>): { code: string; n: number }[] {
  return Object.entries(skips)
    .filter(([, n]) => n > 0)
    .map(([code, n]) => ({ code, n }))
    .sort((a, b) => b.n - a.n);
}

/** 空きの下限が「最大の検査 1 件」より小さい（その検査 1 件で溢れうる）。 */
export function lowFreeWarning(minFreeGb: number | null, largestStudyBytes: number): boolean {
  return minFreeGb != null && largestStudyBytes > 0 && minFreeGb * GB < largestStudyBytes;
}

/** backend のエラー文言 → i18n キー。専用でなければ null（そのまま出す）。 */
export function apiErrorKey(message: string): string | null {
  if (message.includes("cache-mode-unsupported")) return "retention.err.cacheMode";
  if (message.includes("not-enabled")) return "retention.err.notEnabled";
  if (message.includes("running")) return "retention.err.running";
  return null;
}

/** メイン画面の知らせの要約。削除の有無・条件の未達・中断で出し分ける。 */
export function noticeKind(r: RetentionRun): "deleted" | "warning" {
  return r.deleted + r.partial > 0 ? "deleted" : "warning";
}
