/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** メイン画面の［ファイル］→［NIfTI で書き出し…］の純関数と保存。 */
import { NiftiExportRefused, type NiftiExportResult, type Series } from "../api";

/**
 * 既定のファイル名。**患者情報を入れない**（NIfTI は研究で外へ渡すことが多い。SeriesDescription は自由記述で
 * 患者情報が混ざりうるので使わない）。`<モダリティ>_S<系列番号>.nii.gz`。決まらなければ `volume.nii.gz`。
 */
export function niftiFileName(series: Pick<Series, "modality" | "seriesNumber"> | null | undefined): string {
  const mod = (series?.modality ?? "").replace(/[^A-Za-z0-9]/g, "");
  const no = series?.seriesNumber;
  const num = typeof no === "number" && Number.isInteger(no) && no >= 0 ? `S${no}` : "";
  const base = [mod, num].filter(Boolean).join("_");
  return `${base || "volume"}.nii.gz`;
}

export type NiftiExportAvailability = { enabled: true } | { enabled: false; reasonKey: string };

/** メニュー項目を押せるか。押せない理由は画面に出す（項目の title）。公開デモは項目自体を出さない（呼び出し側）。 */
export function niftiExportAvailability(o: {
  series: Series | null;
  isStandalone: boolean;
  busy?: boolean;
}): NiftiExportAvailability {
  if (!o.isStandalone) return { enabled: false, reasonKey: "niftiExport.disabled.web" };
  if (!o.series) return { enabled: false, reasonKey: "niftiExport.disabled.noSeries" };
  if (o.busy) return { enabled: false, reasonKey: "niftiExport.disabled.busy" };
  return { enabled: true };
}

/** backend が断る理由コード → i18n キー。未知のコードは null（画面は生のコードを添えて出す。握りつぶさない）。 */
const REFUSAL_REASONS = new Set([
  "web-mode",
  "series-not-found",
  "anonymize-failed",
  "burnin-incomplete",
  "bad-request",
  "nifti-no-geometry",
  "volume-sheared",
  "npz-big-endian",
  "npz-mixed-geometry",
  "npz-not-grayscale",
  "npz-pixels-unreadable",
  "npz-too-large",
  "npz-empty",
  "npz-mixed-frames",
  "npz-multiple-multiframe",
  "npz-duplicate-positions",
  "npz-uneven-spacing",
  "nifti-4d-uneven-frames",
  "nifti-4d-inconsistent-times",
]);

export const NIFTI_REFUSAL_REASONS: readonly string[] = [...REFUSAL_REASONS];

export function niftiRefusalKey(reason: string): string | null {
  if (REFUSAL_REASONS.has(reason)) return `niftiExport.refused.${reason}`;
  if (/^npz-bits-\d+$/.test(reason)) return "niftiExport.refused.npz-bits";
  return null;
}

/** Blob をファイルとして保存する（ブラウザのダウンロード。Electron でも同じ）。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface NiftiExportDeps {
  exportSeries: (studyUid: string, seriesUid: string) => Promise<NiftiExportResult>;
  save: (blob: Blob, filename: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export interface NiftiExportOutcome {
  text: string;
  error: boolean;
}

/**
 * 1 シリーズを書き出して保存し、画面に出す文言を返す。断られた理由はコードごとの文言（未知のコードは
 * 握りつぶさずコードを添える）。保存は成功したときだけ呼ぶ（断られたらファイルを作らない）。
 */
export async function runNiftiExport(
  study: { studyInstanceUid: string },
  series: Series,
  deps: NiftiExportDeps,
): Promise<NiftiExportOutcome> {
  const { t } = deps;
  const name = niftiFileName(series);
  try {
    const r = await deps.exportSeries(study.studyInstanceUid, series.seriesInstanceUid);
    deps.save(r.blob, name);
    const base = r.slices === null ? t("niftiExport.doneNoCount", { name }) : t("niftiExport.done", { name, n: r.slices });
    if (r.frames <= 1) return { error: false, text: base };
    // 4D: 4 つ目の軸の長さと、時間の間隔（決まるときだけ。推測で埋めない）。軸が時相かは DICOM で確かめてもらう
    const step =
      r.timeStepSec !== null
        ? t("niftiExport.timeStep", { sec: r.timeStepSec })
        : t(r.timeStepStatus === "nonuniform" ? "niftiExport.timeStepNonuniform" : "niftiExport.timeStepUnknown");
    return { error: false, text: `${base} ${t("niftiExport.frames", { frames: r.frames })} ${step}` };
  } catch (e) {
    if (e instanceof NiftiExportRefused) {
      const key = niftiRefusalKey(e.reason);
      return { error: true, text: key ? t("niftiExport.failed", { reason: t(key) }) : t("niftiExport.failedUnknown", { code: e.reason }) };
    }
    return { error: true, text: t("niftiExport.failed", { reason: String(e) }) };
  }
}
