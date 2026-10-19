/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpSend } from "../http";
import { desktop } from "../desktopBridge";
import { tOutsideReact as t } from "../i18n/i18n";
import { notifyDbChanged, pollPluginJob } from "./pluginCommonApi";
import type {
  PluginJobOptions,
  PluginMicroscopyImportOutcome,
  PluginMicroscopyImportRequest,
  PluginMicroscopyImported,
} from "./pluginTypes";

/** 確認画面に出す中身（本体が決める。プラグインからは変えられない）。 */
export interface MicroscopyConfirmLines {
  pluginName: string;
  sourceName: string;
  patient: string;
  channels: string[];
  frames: number;
}

type ConfirmFn = (lines: MicroscopyConfirmLines) => Promise<boolean>;
let confirmOverride: ConfirmFn | null = null;
/** テスト用: 確認画面の代わり。 */
export function __setMicroscopyConfirm(fn: ConfirmFn | null): void {
  confirmOverride = fn;
}

/**
 * H68: プラグインが自分のジョブで書いた画素（Raw）を、チャネルごとに CFM（32 ビット・規格外）として取り込む
 * （fw/microscopy-cfm.md）。**毎回、本体が確認画面を出す**（消せない）。チャネルを順に取り込み、2 本目からは 1 本目の
 * 検査・Frame of Reference・検体の UID を渡す。途中で失敗したら残りを止め、取り込めた分を返す。
 * パスはそのプラグインの一時フォルダ（tmp/graphy-plugin-microscopy/<id>/）の下だけ（本体が確かめる）。
 */
export async function importMicroscopyVolume(
  plugin: { id: string; name: string },
  req: PluginMicroscopyImportRequest,
  opts: PluginJobOptions = {},
): Promise<PluginMicroscopyImportOutcome> {
  // web では本体の口が無い（standalone だけ）。確認画面を出す前に断る
  if (!desktop()) return { ok: false, error: "desktop-only", imported: [] };
  const channels = req?.channels ?? [];
  if (channels.length === 0) return { ok: false, error: "no-channels", imported: [] };
  if (!req.patient?.patientId?.trim()) return { ok: false, error: "no-patient", imported: [] };
  const lines: MicroscopyConfirmLines = {
    pluginName: plugin.name,
    sourceName: req.sourceName ?? "",
    patient: [req.patient.patientId, req.patient.patientName].filter(Boolean).join(" / "),
    channels: channels.map((c, i) => c.channelName || `#${i + 1}`),
    frames: channels.reduce((a, c) => a + (c.spec?.slices ?? 0) * Math.max(1, c.spec?.phases ?? 1), 0),
  };
  const ok = await (confirmOverride ?? showMicroscopyDialog)(lines);
  if (!ok) return { ok: false, cancelled: true, imported: [] };

  const imported: PluginMicroscopyImported[] = [];
  let study: string | undefined;
  let forUid: string | undefined;
  let specimen: string | undefined;
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    let job: { jobId: string };
    try {
      job = await httpSend<{ jobId: string }>(`/api/plugins/${encodeURIComponent(plugin.id)}/microscopy/import`, "POST", {
        path: c.path,
        spec: c.spec,
        channelName: c.channelName,
        wavelengthNm: c.wavelengthNm ?? null,
        confocalMode: req.confocalMode,
        sourceFormat: req.sourceFormat,
        sourceName: req.sourceName,
        anatomy: req.anatomy ?? null,
        patientId: req.patient.patientId,
        patientName: req.patient.patientName,
        patientBirthDate: req.patient.birthDate,
        patientSex: req.patient.sex,
        studyDescription: req.studyDescription,
        seriesDescription: c.channelName,
        seriesNumber: i + 1,
        studyInstanceUid: study,
        frameOfReferenceUid: forUid,
        specimenUid: specimen,
      });
    } catch (e) {
      return finish(plugin.id, imported, study, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    const out = await pollPluginJob(job.jobId, {
      ...opts,
      onProgress: (p, msg) => opts.onProgress?.((i + (p ?? 0)) / channels.length, msg),
    });
    if (!out.ok) return finish(plugin.id, imported, study, { ok: false, error: out.error, cancelled: out.cancelled });
    const r = out.result as { studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUid: string; specimenUid: string; frames: number };
    study = r.studyInstanceUid;
    forUid = r.frameOfReferenceUid;
    specimen = r.specimenUid;
    imported.push({ seriesInstanceUid: r.seriesInstanceUid, channelName: c.channelName ?? "", frames: r.frames });
  }
  return finish(plugin.id, imported, study, { ok: true });
}

function finish(
  pluginId: string,
  imported: PluginMicroscopyImported[],
  study: string | undefined,
  base: { ok: boolean; error?: string; cancelled?: boolean },
): PluginMicroscopyImportOutcome {
  if (imported.length > 0) notifyDbChanged(pluginId, { studyUids: study ? [study] : [] });
  return { ...base, studyInstanceUid: study, imported } as PluginMicroscopyImportOutcome;
}

/** 本体の確認画面（DOM。メイン画面・2D ビューアのどちらでも出せるよう React に載せない）。 */
function showMicroscopyDialog(lines: MicroscopyConfirmLines): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-testid", "plugin-microscopy-consent");
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
    h.textContent = t("pluginMicroscopy.title");
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
    row(t("pluginMicroscopy.source"), lines.sourceName);
    row(t("pluginMicroscopy.patient"), lines.patient);
    row(t("pluginMicroscopy.channels"), `${lines.channels.length}（${lines.channels.join(", ")}）`);
    row(t("pluginMicroscopy.frames"), String(lines.frames));
    const note = document.createElement("div");
    note.textContent = t("pluginMicroscopy.note");
    Object.assign(note.style, { color: "#7a4a00", fontSize: "12px", margin: "10px 0 12px" });
    box.appendChild(note);
    const bar = document.createElement("div");
    Object.assign(bar.style, { display: "flex", justifyContent: "flex-end", gap: "8px" });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("common.cancel");
    cancel.setAttribute("data-testid", "plugin-microscopy-consent-cancel");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = t("pluginMicroscopy.ok");
    ok.setAttribute("data-testid", "plugin-microscopy-consent-ok");
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
