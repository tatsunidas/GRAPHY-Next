/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { fetchSeries, fetchStudies, type Study } from "../api";
import { fetchEmrStatus } from "../settings/emrApi";
import { decideLatest, newestExact } from "./emrOpenLogic";
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

/** 電子カルテの患者の直近の検査を、取り込みが終わるまで待つ上限。 */
const LATEST_TIMEOUT_MS = 180_000;
const LATEST_POLL_MS = 500;
/** ［開く］ボタン（メイン画面）から、この窗の ExternalOpenHost へ「電子カルテの患者を開く」を頼むイベント。 */
export const EMR_OPEN_EVENT = "graphy:emr-open";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  /** 電子カルテの「直近の検査を開く」の世代。新しい要求が来たら増やし、古い待ちはそれを見て打ち切る。 */
  const latestGen = useRef(0);

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

  /** 検査をそのまま（先頭のシリーズで）2D ビューアへ渡す。選ぶ・確認するダイアログは出さない。 */
  const openStudyDirect = async (study: Study) => {
    const list = await fetchSeries(study.studyInstanceUid).catch(() => []);
    const pick = pickSeries({}, list);
    localStorage.setItem("graphy-viewer-ctx", JSON.stringify({ study, series: pick.kind === "series" ? pick.series : undefined, ts: Date.now() }));
    const d = desktop();
    if (d?.openViewer) await d.openViewer("2dviewer");
  };

  /**
   * 電子カルテの患者の直近の検査を開く。開くのは PACS の直近の検査（backend が取り込む）。取り込みが終わるまで待ち、
   * PACS に無い・取れないときは、手元にあるその患者の最新の検査を開く（無ければ理由を出す）。
   * 新しい要求が来たら、古い待ちはやめる（患者が切り替わったのに、前の患者が開かない）。
   */
  const handleLatest = async (patientId: string) => {
    const gen = ++latestGen.current;
    const stale = () => gen !== latestGen.current;
    const started = Date.now();
    for (;;) {
      const status = await fetchEmrStatus().catch(() => null);
      if (stale()) return;
      const dec = decideLatest(status, patientId, Date.now() - started, LATEST_TIMEOUT_MS);
      if (dec.kind === "wait") {
        await sleep(LATEST_POLL_MS);
        if (stale()) return;
        continue;
      }
      if (dec.kind === "open") {
        const hit = (await fetchStudies({ studyInstanceUid: dec.studyUid }).catch(() => [] as Study[]))
          .find((x) => x.studyInstanceUid === dec.studyUid);
        if (stale()) return;
        if (hit) {
          await openStudyDirect(hit);
          return;
        }
        // 取り込んだはずが手元に無い: 手元の最新に逃げる
      }
      const local = newestExact(await fetchStudies({ patientId }).catch(() => [] as Study[]), patientId);
      if (stale()) return;
      if (local) {
        await openStudyDirect(local);
        return;
      }
      const reasonKey = dec.kind === "local" && dec.reason === "not-found" ? "emr.open.none"
        : dec.kind === "timeout" ? "emr.open.timeout" : "emr.open.failed";
      setDialog({ kind: "message", text: t(reasonKey) });
      return;
    }
  };

  /** handleLatest の失敗（ビューアが開けないなど）を、画面の理由にする（握りつぶさない）。 */
  const runLatest = (patientId: string) =>
    handleLatest(patientId).catch(() => setDialog({ kind: "message", text: t("emr.open.failed") }));

  useEffect(() => {
    const onEvent = (e: Event) => {
      const id = (e as CustomEvent<{ patientId?: string }>).detail?.patientId;
      if (id) void runLatest(id);
      else setDialog({ kind: "message", text: t("emr.open.noPatient") });
    };
    window.addEventListener(EMR_OPEN_EVENT, onEvent);
    return () => window.removeEventListener(EMR_OPEN_EVENT, onEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const d = desktop();
    if (!d?.onExternalOpen) return; // web（ブラウザ）では何もしない
    const off = d.onExternalOpen((raw: unknown) => {
      // 電子カルテの患者を開く要求は、前の待ちを打ち切って、いつでも受ける（連続で患者が切り替わるため）
      const parsed = normalizeMsg(raw);
      if (parsed.ok && parsed.req.latest && parsed.req.patientId) {
        void runLatest(parsed.req.patientId);
        return;
      }
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
