/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインのための<b>動画の取り込み</b>（host API の H47 / H48 / H49）。
 *
 * <ul>
 *   <li>H47 `video.probe(path)` … 諸元・指紋・既に取り込み済みか（本体の ffmpeg で調べる。ffprobe 不要）</li>
 *   <li>H48 `video.requestImportConsent(req)` → `video.importAsDicom(req)` … 本体の確認ダイアログを
 *       <b>1 回の取り込みにつき 1 回</b>出し、その同意（札）の範囲で 1 本ずつ取り込む</li>
 *   <li>H49 `video.readFrameValues(sop)` … 取り込み時に書いた「フレームごとの値」の SR を読む</li>
 * </ul>
 *
 * <h3>🔴 DICOM はプラグインに書かせない（H4b / H9 と同じ）</h3>
 * 変換・DICOM の組み立て・UID・患者属性・出所（`[Plugin] `・ContributingEquipment）は本体が行う。
 * 保管庫へ書く前には、本体が<b>必ず</b>確認ダイアログを出す（抑止不可）。札は、そのダイアログで
 * 見せた<b>患者・ファイル・書くもの</b>の範囲でしか使えない（別の患者・別のファイル・
 * 見せていない SR を書こうとすると拒否する）。
 *
 * 設計: `fw/plugin-architecture.md`（host API の表の H47〜H49）。
 */
import { HttpError, httpGet, httpSend } from "../http";
import { tOutsideReact as t } from "../i18n/i18n";
import { log } from "../log";
import { notifyDbChanged, pollPluginJob, searchPatients, type PluginJobOptions } from "./pluginCommonApi";

/** H47 の結果。 */
export interface PluginVideoProbe {
  path: string;
  fileName: string;
  sizeBytes: number;
  /** 元ファイルの SHA-256（16 進）。同じ動画の判定に使う。 */
  sha256: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** 数え直したフレーム数（コンテナのヘッダの値ではない）。 */
  frameCount: number;
  durationSec: number;
  /** 同じ動画が既に保管庫にあれば、その所在。**あれば取り込まない**（H48 も重複として返す）。 */
  alreadyImported: { sopInstanceUid: string; studyInstanceUid: string; patientId: string; patientName: string } | null;
}

/** 患者の指定。既存（`db.searchPatients` の `patientKey`）か、新しい患者か。 */
export type PluginVideoPatient =
  | { patientKey: string }
  | { create: { patientId: string; patientName?: string; birthDate?: string; sex?: string } };

/** フレームごとの値の 1 系列（フレーム 1〜N の順）。`unit` は UCUM（無次元は "1"・既定）。 */
export interface PluginFrameValuesSeries {
  /** 英数字と _ の 1〜16 文字。 */
  key: string;
  label: string;
  unit?: string;
  values: number[];
}

/** フレームごとの値。系列の長さは**動画のフレーム数と一致すること**（違えば SR は書かれない）。 */
export interface PluginFrameValues {
  series: PluginFrameValuesSeries[];
  /** 解析の条件など（例 `{ scoreSource: "SOURCE_VIDEO" }`）。SR にそのまま残る。 */
  params?: Record<string, string>;
}

/** H48 の同意の要求（確認ダイアログに出す中身）。 */
export interface PluginVideoConsentRequest {
  patient: PluginVideoPatient;
  /** 取り込むファイル（`file.pickFiles` で選んだ絶対パス）。 */
  paths: string[];
  /** `"US"` は US Multi-frame。既定は Video Photographic（本体の非 DICOM 取り込みと同じ）。 */
  modality?: "US";
  /** フレームごとの値の SR も書くなら、その説明（ダイアログにそのまま出る）。 */
  frameValues?: { description: string };
}

export type PluginVideoConsentResult =
  | { ok: true; consentToken: string }
  | { ok: false; cancelled?: boolean; error?: string };

/** H48 の 1 本分の要求。 */
export interface PluginVideoImportRequest {
  consentToken: string;
  path: string;
  /** 同意のときと**同じ**指定であること。 */
  patient: PluginVideoPatient;
  modality?: "US";
  /** 同じ取り込みの 2 本目以降は、1 本目の結果の `studyInstanceUid` を渡すと同じ検査に入る。 */
  studyInstanceUid?: string;
  studyDescription?: string;
  /** 省略時はファイル名。本体が `[Plugin] ` を前に付ける。 */
  seriesDescription?: string;
  frameValues?: PluginFrameValues;
}

/** H48 の 1 本分の結果。 */
export interface PluginVideoImportResult {
  /** 同じ動画が既にあったので書かなかった（`sopInstanceUid` は既存のもの）。 */
  duplicate: boolean;
  sopInstanceUid: string;
  seriesInstanceUid: string | null;
  studyInstanceUid: string;
  patientId: string;
  numberOfFrames: number;
  /** H.264 High へ変換したか（元が包める MP4 なら変換しない）。 */
  transcoded: boolean;
  /** フレームごとの値の SR（書いたときだけ）。 */
  frameValuesSopInstanceUid: string | null;
  /** SR を書けなかった理由（長さ違い等）。動画は取り込まれている。 */
  frameValuesError: string | null;
}

export type PluginVideoImportOutcome =
  | { ok: true; result: PluginVideoImportResult }
  | { ok: false; cancelled?: boolean; error?: string };

/** H49 の結果。 */
export interface PluginFrameValuesRead {
  sopInstanceUid: string;
  videoSopInstanceUid: string;
  producerId: string;
  /** SR を書いた日（YYYYMMDD）。 */
  contentDate: string;
  series: { key: string; label: string; unit: string; values: number[] }[];
  params: Record<string, string>;
}

// ── 同意の札 ──

interface Consent {
  pluginId: string;
  patient: string;
  paths: Set<string>;
  used: Set<string>;
  modality: string;
  frameValues: boolean;
  expiresAt: number;
}

/** 札の有効時間。取り込み（変換）が長いので長めに取るが、無期限にはしない。 */
const CONSENT_TTL_MS = 2 * 60 * 60 * 1000;
const consents = new Map<string, Consent>();

const patientSig = (p: PluginVideoPatient) =>
  "patientKey" in p
    ? `key:${p.patientKey}`
    : `new:${JSON.stringify([p.create.patientId, p.create.patientName ?? "", p.create.birthDate ?? "", p.create.sex ?? ""])}`;

/** テスト用: 札を捨てる。 */
export function __resetVideoConsents(): void {
  consents.clear();
}

/** 確認ダイアログを出す（差し替えられるようにしてある。テストでは画面を出さない）。 */
export type ConfirmFn = (lines: ConsentLines) => Promise<boolean>;

export interface ConsentLines {
  pluginName: string;
  patient: string;
  modality: string;
  files: string[];
  frameValues: string | null;
}

let confirmImpl: ConfirmFn = showConsentDialog;

/** テスト用: 確認ダイアログの代わりを入れる。 */
export function __setVideoConsentConfirm(fn: ConfirmFn | null): void {
  confirmImpl = fn ?? showConsentDialog;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

async function describePatient(p: PluginVideoPatient): Promise<string> {
  if ("patientKey" in p) {
    const hit = (await searchPatients(p.patientKey)).find((x) => x.patientKey === p.patientKey);
    if (!hit) throw new Error(`patient not found: ${p.patientKey}`);
    return t("pluginVideo.consent.patientExisting", { id: hit.patientId, name: hit.patientName || "-" });
  }
  const c = p.create;
  return t("pluginVideo.consent.patientNew", { id: c.patientId, name: c.patientName || "-" });
}

/** H48（前半）: 確認ダイアログを出し、同意の札を返す。 */
export async function requestVideoImportConsent(
  plugin: { id: string; name: string },
  req: PluginVideoConsentRequest,
): Promise<PluginVideoConsentResult> {
  if (!req || !Array.isArray(req.paths) || req.paths.length === 0) return { ok: false, error: "no-paths" };
  let patientText: string;
  try {
    patientText = await describePatient(req.patient);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const ok = await confirmImpl({
    pluginName: plugin.name,
    patient: patientText,
    modality: t(req.modality === "US" ? "pluginVideo.consent.modalityUS" : "pluginVideo.consent.modalityVideo"),
    files: req.paths.map(baseName),
    frameValues: req.frameValues ? req.frameValues.description : null,
  });
  if (!ok) return { ok: false, cancelled: true };
  const token = `${plugin.id}:${crypto.randomUUID()}`;
  consents.set(token, {
    pluginId: plugin.id,
    patient: patientSig(req.patient),
    paths: new Set(req.paths),
    used: new Set(),
    modality: req.modality ?? "",
    frameValues: !!req.frameValues,
    expiresAt: Date.now() + CONSENT_TTL_MS,
  });
  log.info(`[plugin-video] consent: ${plugin.id} ${req.paths.length} file(s)`);
  return { ok: true, consentToken: token };
}

/** 札で許された範囲か。違反の理由を返す（許されていれば null）。 */
function checkConsent(pluginId: string, req: PluginVideoImportRequest): string | null {
  const c = consents.get(req.consentToken);
  if (!c || c.pluginId !== pluginId) return "no-consent";
  if (Date.now() > c.expiresAt) return "consent-expired";
  if (!c.paths.has(req.path)) return "path-not-consented";
  if (c.used.has(req.path)) return "path-already-imported";
  if (c.patient !== patientSig(req.patient)) return "patient-not-consented";
  if ((req.modality ?? "") !== c.modality) return "modality-not-consented";
  if (req.frameValues && !c.frameValues) return "frame-values-not-consented";
  return null;
}

/** H47: 諸元・指紋・取り込み済みか。 */
export function probeVideo(pluginId: string, path: string): Promise<PluginVideoProbe> {
  return httpSend<PluginVideoProbe>(`/api/plugins/${encodeURIComponent(pluginId)}/video/probe`, "POST", { path });
}

/** H48（後半）: 1 本取り込む。例外は投げない。 */
export async function importVideoAsDicom(
  pluginId: string,
  req: PluginVideoImportRequest,
  opts: PluginJobOptions = {},
): Promise<PluginVideoImportOutcome> {
  const denied = checkConsent(pluginId, req);
  if (denied) return { ok: false, error: denied };
  const c = consents.get(req.consentToken)!;
  c.used.add(req.path); // 失敗しても同じ札で撃ち直させない（同意は「この 1 回」に対するもの）
  const body = {
    path: req.path,
    patient: "patientKey" in req.patient ? { patientKey: req.patient.patientKey } : { create: req.patient.create },
    modality: req.modality ?? null,
    studyInstanceUid: req.studyInstanceUid ?? null,
    studyDescription: req.studyDescription ?? null,
    seriesDescription: req.seriesDescription ?? null,
    frameValues: req.frameValues
      ? {
          series: req.frameValues.series.map((s) => ({ key: s.key, label: s.label, unit: s.unit ?? "1", values: s.values })),
          params: req.frameValues.params ?? {},
        }
      : null,
  };
  let jobId: string;
  try {
    jobId = (await httpSend<{ jobId: string }>(`/api/plugins/${encodeURIComponent(pluginId)}/video/imports`, "POST", body)).jobId;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const out = await pollPluginJob(jobId, opts);
  if (!out.ok) return out;
  const result = out.result as PluginVideoImportResult;
  if (!result.duplicate) {
    // 一覧（メイン画面・他のウィンドウ）を読み直させる
    notifyDbChanged(pluginId, { studyUids: [result.studyInstanceUid], patientId: result.patientId });
  }
  return { ok: true, result };
}

/** H49: フレームごとの値の SR を読む。無ければ null。 */
export async function readVideoFrameValues(pluginId: string, sopInstanceUid: string): Promise<PluginFrameValuesRead | null> {
  try {
    return await httpGet<PluginFrameValuesRead>(
      `/api/plugins/${encodeURIComponent(pluginId)}/video/frame-values/${encodeURIComponent(sopInstanceUid)}`,
    );
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

// ── 確認ダイアログ（DOM。メイン画面・2D ビューアのどちらでも出せるよう React に載せない） ──

/**
 * 本体の確認ダイアログ。**プラグインからは消せない・文言も変えられない**（出す中身は本体が決める）。
 * `window.confirm` を使わない理由は `PluginSaveConfirmDialog.tsx` と同じ（Electron のネイティブダイアログが
 * キーボードフォーカスを奪う）。
 */
function showConsentDialog(lines: ConsentLines): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("data-testid", "plugin-video-consent");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "100000", background: "rgba(10,20,30,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center",
    } as Partial<CSSStyleDeclaration>);
    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "#fff", color: "#223", borderRadius: "10px", padding: "18px 20px", width: "min(560px, 92vw)",
      maxHeight: "80vh", overflow: "auto", boxShadow: "0 10px 40px rgba(0,0,0,0.3)", fontSize: "13px", lineHeight: "1.6",
    } as Partial<CSSStyleDeclaration>);
    const h = document.createElement("div");
    h.textContent = t("pluginVideo.consent.title");
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
    row(t("pluginVideo.consent.patient"), lines.patient);
    row(t("pluginVideo.consent.modality"), lines.modality);
    const files = document.createElement("ul");
    Object.assign(files.style, { margin: "6px 0 6px 18px", padding: "0", maxHeight: "30vh", overflow: "auto" });
    for (const f of lines.files) {
      const li = document.createElement("li");
      li.textContent = f;
      files.appendChild(li);
    }
    row(t("pluginVideo.consent.files", { n: lines.files.length }), "");
    box.appendChild(files);
    if (lines.frameValues) row(t("pluginVideo.consent.frameValues"), lines.frameValues);
    const note = document.createElement("div");
    note.textContent = t("pluginVideo.consent.provenance");
    Object.assign(note.style, { color: "#667", fontSize: "12px", margin: "10px 0 12px" });
    box.appendChild(note);
    const bar = document.createElement("div");
    Object.assign(bar.style, { display: "flex", justifyContent: "flex-end", gap: "8px" });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("common.cancel");
    cancel.setAttribute("data-testid", "plugin-video-consent-cancel");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = t("pluginVideo.consent.ok");
    ok.setAttribute("data-testid", "plugin-video-consent-ok");
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
