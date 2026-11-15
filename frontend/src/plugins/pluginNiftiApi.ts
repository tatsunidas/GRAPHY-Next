/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { HttpError, httpSend } from "../http";
import { desktop } from "../desktopBridge";
import { tOutsideReact as t } from "../i18n/i18n";
import { notifyDbChanged, pollPluginJob } from "./pluginCommonApi";
import type {
  PluginJobOptions,
  PluginNiftiExportOutcome,
  PluginNiftiExportRequest,
  PluginNiftiImportOutcome,
  PluginNiftiImportRequest,
} from "./pluginTypes";

/** 確認画面に出す中身（本体が決める。プラグインからは変えられない）。 */
export interface NiftiConfirmLines {
  pluginName: string;
  sourceName: string;
  patient: string;
  /** 例: `64×64×30（4D: 8 時相）`。プラグインの申告ではなく、本体がファイルのヘッダから読んだ値。 */
  shape: string;
  format: string;
  /** 向きが NIfTI に無く、本体が合成する。 */
  geometrySynthesized: boolean;
}

type ConfirmFn = (lines: NiftiConfirmLines) => Promise<boolean>;
let confirmOverride: ConfirmFn | null = null;
/** テスト用: 確認画面の代わり。 */
export function __setNiftiConfirm(fn: ConfirmFn | null): void {
  confirmOverride = fn;
}

/** backend の `NiftiImportController.Probe` のうち、確認画面に使う分。 */
interface NiftiProbe {
  columns: number;
  rows: number;
  slices: number;
  phases: number;
  channels: number;
  format?: string | null;
  geometrySynthesized: boolean;
  supported: boolean;
  pixelConversion?: string | null;
  error?: string | null;
}

const BASE = (id: string) => `/api/plugins/${encodeURIComponent(id)}/nifti`;

function messageOf(e: unknown): string {
  return e instanceof HttpError || e instanceof Error ? e.message : String(e);
}

/** H78: 1 シリーズを NIfTI にして、そのプラグインの一時フォルダへ渡す（確認画面は出さない）。 */
export async function exportNiftiSeries(pluginId: string, req: PluginNiftiExportRequest): Promise<PluginNiftiExportOutcome> {
  // web では本体の口が無い（standalone だけ）
  if (!desktop()) return { ok: false, error: "desktop-only" };
  if (!req?.studyUid || !req?.seriesUid) return { ok: false, error: "bad-request" };
  try {
    return await httpSend<PluginNiftiExportOutcome>(`${BASE(pluginId)}/export`, "POST", { studyUid: req.studyUid, seriesUid: req.seriesUid });
  } catch (e) {
    // 断る形（チルト・欠け・モザイク・手がかり無しの 4D など）は 422 と理由コード
    return { ok: false, error: messageOf(e) };
  }
}

/** H78: 渡したファイルを消す（そのプラグインの一時フォルダの下だけ。本体が確かめる）。 */
export async function releaseNifti(pluginId: string, path: string): Promise<{ ok: boolean; error?: string }> {
  if (!desktop()) return { ok: false, error: "desktop-only" };
  try {
    await httpSend(`${BASE(pluginId)}/release`, "POST", { path });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

/**
 * H79: プラグインが作った NIfTI を取り込む。**毎回、本体が確認画面を出す**（消せない）。流れ: ヘッダの下読み（本体が読む。
 * 形・向きが合成か）→ 確認画面 → 「取り込む」だけ取り込む。やめたときは本体は何も取り込まず、ファイルにも触らない。
 * パスはそのプラグインの一時フォルダ（tmp/graphy-plugin-nifti/<id>/）の下だけ（本体が確かめる）。
 */
export async function importNiftiVolume(
  plugin: { id: string; name: string },
  req: PluginNiftiImportRequest,
  opts: PluginJobOptions = {},
): Promise<PluginNiftiImportOutcome> {
  // web では本体の口が無い（standalone だけ）。確認画面を出す前に断る
  if (!desktop()) return { ok: false, error: "desktop-only" };
  if (!req?.path?.trim()) return { ok: false, error: "no-path" };
  if (!req.patient?.patientId?.trim()) return { ok: false, error: "no-patient" };

  let probe: NiftiProbe;
  try {
    probe = await httpSend<NiftiProbe>(`${BASE(plugin.id)}/probe`, "POST", { path: req.path });
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
  if (!probe.supported) return { ok: false, error: probe.pixelConversion || probe.error || "unsupported" };

  const lines: NiftiConfirmLines = {
    pluginName: plugin.name,
    sourceName: req.sourceName ?? "",
    patient: [req.patient.patientId, req.patient.patientName].filter(Boolean).join(" / "),
    shape: `${probe.columns}×${probe.rows}×${probe.slices}` + (probe.phases > 1 ? t("pluginNifti.phases", { n: probe.phases }) : ""),
    format: probe.format ?? "NIfTI",
    geometrySynthesized: probe.geometrySynthesized,
  };
  const ok = await (confirmOverride ?? showNiftiDialog)(lines);
  if (!ok) return { ok: false, cancelled: true };

  let job: { jobId: string };
  try {
    job = await httpSend<{ jobId: string }>(`${BASE(plugin.id)}/import`, "POST", {
      path: req.path,
      metadataPath: req.sidecar ?? null,
      modality: req.modality,
      patientId: req.patient.patientId,
      patientName: req.patient.patientName,
      patientBirthDate: req.patient.birthDate,
      patientSex: req.patient.sex,
      studyDescription: req.studyDescription,
      seriesDescription: req.seriesDescription,
      seriesNumber: req.seriesNumber,
      studyInstanceUid: req.studyInstanceUid,
      valueUnit: req.valueUnit,
    });
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
  const out = await pollPluginJob(job.jobId, opts);
  if (!out.ok) return { ok: false, error: out.error, cancelled: out.cancelled };
  const r = out.result as {
    studyInstanceUid: string;
    seriesInstanceUid: string;
    slices: number;
    phases: number;
    geometrySynthesized: boolean;
  };
  notifyDbChanged(plugin.id, { studyUids: r.studyInstanceUid ? [r.studyInstanceUid] : [] });
  return {
    ok: true,
    studyInstanceUid: r.studyInstanceUid,
    seriesInstanceUid: r.seriesInstanceUid,
    slices: r.slices,
    phases: r.phases,
    geometrySynthesized: r.geometrySynthesized,
  };
}

/** 本体の確認画面（DOM。メイン画面・2D ビューアのどちらでも出せるよう React に載せない）。 */
function showNiftiDialog(lines: NiftiConfirmLines): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-testid", "plugin-nifti-consent");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "100000", background: "rgba(10,20,30,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
    } as Partial<CSSStyleDeclaration>);
    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "#fff", color: "#223", borderRadius: "10px", padding: "18px 20px", width: "min(520px, 92vw)",
      boxShadow: "0 10px 40px rgba(0,0,0,0.3)", fontSize: "13px", lineHeight: "1.6",
    } as Partial<CSSStyleDeclaration>);
    const h = document.createElement("div");
    h.textContent = t("pluginNifti.title");
    Object.assign(h.style, { fontSize: "15px", fontWeight: "700", marginBottom: "10px" });
    box.appendChild(h);
    const row = (label: string, value: string) => {
      const d = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = `${label}: `;
      d.append(b, document.createTextNode(value));
      box.appendChild(d);
    };
    row(t("pluginVideo.consent.plugin"), lines.pluginName);
    row(t("pluginNifti.source"), lines.sourceName);
    row(t("pluginNifti.patient"), lines.patient);
    row(t("pluginNifti.shape"), `${lines.shape}（${lines.format}）`);
    const note = document.createElement("div");
    note.textContent = t("pluginNifti.note");
    Object.assign(note.style, { color: "#7a4a00", fontSize: "12px", margin: "10px 0 6px" });
    box.appendChild(note);
    if (lines.geometrySynthesized) {
      const warn = document.createElement("div");
      warn.setAttribute("data-testid", "plugin-nifti-consent-synth");
      warn.textContent = t("pluginNifti.geometrySynthesized");
      Object.assign(warn.style, { color: "#b00020", fontSize: "12px", fontWeight: "600", margin: "0 0 10px" });
      box.appendChild(warn);
    }
    const bar = document.createElement("div");
    Object.assign(bar.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("common.cancel");
    cancel.setAttribute("data-testid", "plugin-nifti-consent-cancel");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = t("pluginNifti.ok");
    ok.setAttribute("data-testid", "plugin-nifti-consent-ok");
    for (const [btn, primary] of [[cancel, false], [ok, true]] as const) {
      Object.assign(btn.style, {
        padding: "6px 14px", borderRadius: "6px", cursor: "pointer", fontSize: "13px",
        border: primary ? "1px solid #0b5cad" : "1px solid #cdd5de",
        background: primary ? "#0b5cad" : "#f4f7fa", color: primary ? "#fff" : "#334",
      } as Partial<CSSStyleDeclaration>);
    }
    bar.append(cancel, ok);
    box.appendChild(bar);
    overlay.appendChild(box);
    const done = (v: boolean) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    cancel.focus();
  });
}
