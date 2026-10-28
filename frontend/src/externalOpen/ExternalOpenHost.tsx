/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { fetchSeries, fetchStudies, type Study } from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { fetchSettings } from "../settings/settingsApi";
import {
  normalizeMsg,
  notFoundText,
  pickSeries,
  readFlags,
  resolveStudies,
  toFilters,
  type ExternalReq,
} from "./externalOpenLogic";

type Dialog =
  | { kind: "message"; text: string }
  | { kind: "choose"; req: ExternalReq; studies: Study[] }
  | { kind: "confirm"; req: ExternalReq; study: Study };

/**
 * 外部（RIS など）から「この検査を開く」を受ける（メインウィンドウだけ）。
 * main（desktop/externalOpen.js）が検証した要求が届くと、検査を探し、設定（受け付ける・開く前に確認する）に従って 2D ビューアを開く。
 * 見つからない・複数該当・受け付けない・シリーズが無いときは、理由を出して何も開かない（黙って別の検査を開かない）。
 * 🔴 UID・患者情報は console に出さない。
 */
export function ExternalOpenHost() {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const busy = useRef(false);

  const open = async (req: ExternalReq, study: Study) => {
    const list = await fetchSeries(study.studyInstanceUid).catch(() => []);
    const pick = pickSeries(req, list);
    if (pick.kind === "missing") {
      setDialog({ kind: "message", text: t("externalOpen.seriesMissing", { uid: req.seriesInstanceUid ?? "" }) });
      return;
    }
    // 2D ビューアが開く検査は、メイン画面の「2D Viewer」と同じ経路（localStorage の ctx）で渡す。開いている 2D 窓は差し替わる。
    localStorage.setItem("graphy-viewer-ctx", JSON.stringify({ study, series: pick.series, ts: Date.now() }));
    const d = desktop();
    if (d?.openViewer) await d.openViewer("2dviewer");
  };

  const proceed = async (req: ExternalReq, study: Study, flags: { confirm: boolean }) => {
    if (flags.confirm) {
      setDialog({ kind: "confirm", req, study });
      return;
    }
    await open(req, study);
  };

  const handle = async (raw: unknown) => {
    const msg = normalizeMsg(raw);
    if (!msg.ok) {
      setDialog({ kind: "message", text: t("externalOpen.invalid", { reason: msg.reason }) });
      return;
    }
    const settings = await fetchSettings().catch(() => ({} as Record<string, string>));
    const flags = readFlags(settings);
    if (!flags.enabled) {
      setDialog({ kind: "message", text: t("externalOpen.disabled") });
      return;
    }
    let studies: Study[];
    try {
      studies = await fetchStudies(toFilters(msg.req));
    } catch (e) {
      setDialog({ kind: "message", text: t("common.fetchError", { error: String(e) }) });
      return;
    }
    const r = resolveStudies(msg.req, studies);
    if (r.kind === "none") {
      const nf = notFoundText(msg.req);
      setDialog({ kind: "message", text: t(nf.key, nf.params) });
    } else if (r.kind === "many") {
      setDialog({ kind: "choose", req: msg.req, studies: r.studies });
    } else {
      await proceed(msg.req, r.study, flags);
    }
  };

  useEffect(() => {
    const d = desktop();
    if (!d?.onExternalOpen) return; // web（ブラウザ）では何もしない
    const off = d.onExternalOpen((raw: unknown) => {
      // 要求は 1 件ずつ処理する（連続で届いても、画面の選択を取り合わない）
      if (busy.current) return;
      busy.current = true;
      void handle(raw).finally(() => {
        busy.current = false;
      });
    });
    d.externalOpenReady?.();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!dialog) return null;
  const close = () => setDialog(null);
  return (
    <div style={overlay} role="dialog" aria-modal="true" data-testid="external-open-dialog">
      <div style={box}>
        {dialog.kind === "message" && (
          <>
            <div style={title}>{t("externalOpen.title")}</div>
            <div style={{ marginBottom: 12 }}>{dialog.text}</div>
            <div style={actions}>
              <button style={btn} onClick={close}>{t("common.close")}</button>
            </div>
          </>
        )}
        {dialog.kind === "confirm" && (
          <>
            <div style={title}>{t("externalOpen.title")}</div>
            <div style={{ marginBottom: 12 }}>
              {t("externalOpen.confirm", { patient: dialog.study.patientName || dialog.study.patientId || "—", date: dialog.study.studyDate || "—" })}
            </div>
            <div style={actions}>
              <button style={btn} onClick={close}>{t("common.cancel")}</button>
              <button style={{ ...btn, background: "#0b5cad", color: "#fff", border: "none" }}
                onClick={() => { const { req, study } = dialog; close(); void open(req, study); }}>
                {t("externalOpen.open")}
              </button>
            </div>
          </>
        )}
        {dialog.kind === "choose" && (
          <>
            <div style={title}>{t("externalOpen.choose")}</div>
            <div style={{ maxHeight: 260, overflow: "auto", marginBottom: 12 }}>
              {dialog.studies.map((s) => (
                <button key={s.studyInstanceUid} style={row}
                  onClick={() => { const { req } = dialog; close(); void open(req, s); }}>
                  <span style={{ fontWeight: 600 }}>{s.patientName || s.patientId}</span>
                  <span> {s.studyDate ?? ""} {s.modality ?? ""} {s.studyDescription ?? ""}</span>
                </button>
              ))}
            </div>
            <div style={actions}>
              <button style={btn} onClick={close}>{t("common.cancel")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5000,
};
const box: React.CSSProperties = {
  background: "#fff", borderRadius: 8, padding: "16px 20px", minWidth: 340, maxWidth: 560, fontSize: 13, color: "#1f2a37", boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
};
const title: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 10 };
const actions: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end" };
const btn: React.CSSProperties = { padding: "5px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const row: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left", padding: "7px 10px", marginBottom: 4, border: "1px solid #dfe5ec", borderRadius: 6, background: "#f8fafc", cursor: "pointer", fontSize: 13,
};
