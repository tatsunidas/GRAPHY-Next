/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ハンギングプロトコル（保存済みを選ぶか、JSON を貼り付ける）を適用するダイアログ。
 *
 * <p>「確認」で、画面を変える前に**並ぶ順・行×列・埋まらないスロット・閉じるタイルの枚数**を出し、「適用」で初めて置き換える。
 * `window.confirm` は使わない（Electron のネイティブダイアログはレンダラのキーボードフォーカスを奪い、自動検証からも操作できない）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Series, Study } from "../api";
import { useI18n } from "../i18n/i18n";
import { viewerOverlayProps } from "../viewer/viewerOverlay";
import { planHanging, type HangingPlan } from "./hangingApply";
import type { SettingsMap } from "../settings/settingsApi";
import { prettyProtocol } from "./HangingProtocolManageDialog";
import { extractProtocols, sortForStudy } from "./hangingProtocolStore";
import { parseHangingProtocol, type HangingProtocol } from "./hangingProtocol";

const PLACEHOLDER = `{
  "id": "head-mr",
  "name": "Head MR",
  "version": 1,
  "match": { "modality": ["MR"] },
  "slots": [
    { "series": { "descriptionContains": "T1" } },
    { "series": { "descriptionContains": "T2" } }
  ],
  "grid": { "rows": 1, "cols": 2 }
}`;

export interface HangingApplyChoice {
  series: Series[];
  rows: number;
  cols: number;
}

type Checked =
  | { kind: "errors"; errors: string[] }
  | { kind: "loading" }
  | { kind: "load-failed"; detail: string }
  | { kind: "plan"; protocol: HangingProtocol; plan: HangingPlan<Series> };

export function HangingProtocolApplyDialog({
  study,
  loadSeries,
  loadSettings,
  closingCount,
  transientCount,
  portrait,
  onApply,
  onClose,
}: {
  study: Study;
  loadSeries: (studyUid: string) => Promise<Series[]>;
  /** 保存済みのプロトコルを読むための設定の取得。 */
  loadSettings: () => Promise<SettingsMap>;
  /** 置き換えで閉じる、今のタイルの枚数。 */
  closingCount: number;
  /** そのうちプラグインの一時タイル（元に戻せない）。 */
  transientCount: number;
  portrait: boolean;
  onApply: (choice: HangingApplyChoice) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);

  const [saved, setSaved] = useState<HangingProtocol[]>([]);
  const [savedError, setSavedError] = useState("");
  useEffect(() => {
    loadSettings()
      .then((m) => setSaved(sortForStudy(extractProtocols(m).items, study)))
      .catch((e: unknown) => setSavedError(e instanceof Error ? e.message : String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 確認の通し番号。後から始めた確認や書き換えがあれば、古い読み込みの結果は捨てる。 */
  const request = useRef(0);

  const check = async (source: string) => {
    const mine = ++request.current;
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (e) {
      setChecked({ kind: "errors", errors: [t("viewer2d.hanging.jsonError", { detail: e instanceof Error ? e.message : String(e) })] });
      return;
    }
    const parsed = parseHangingProtocol(raw);
    if (!parsed.ok) {
      setChecked({ kind: "errors", errors: parsed.errors });
      return;
    }
    setChecked({ kind: "loading" });
    try {
      const list = await loadSeries(study.studyInstanceUid);
      const plan = planHanging(parsed.protocol, study, list, { portrait });
      if (request.current === mine) setChecked({ kind: "plan", protocol: parsed.protocol, plan });
    } catch (e) {
      if (request.current === mine) setChecked({ kind: "load-failed", detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const plan = checked?.kind === "plan" ? checked.plan : null;

  return createPortal(
    <div style={backdrop}>
      <div style={panel} data-testid="hanging-apply-dialog" {...viewerOverlayProps}>
        <div style={title}>{t("viewer2d.hanging.title")}</div>
        <div style={body}>
          <p style={lead}>{t("viewer2d.hanging.lead", { study: study.studyDescription || study.studyInstanceUid })}</p>
          {saved.length > 0 && (
            <select
              data-testid="hanging-saved"
              style={select}
              value=""
              onChange={(e) => {
                const p = saved.find((x) => x.id === e.target.value);
                if (!p) return;
                const next = prettyProtocol(p);
                setText(next);
                void check(next);
              }}
            >
              <option value="">{t("viewer2d.hanging.saved")}</option>
              {saved.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {savedError && <p style={errorText} data-testid="hanging-saved-error">{t("viewer2d.hanging.manage.failed", { detail: savedError })}</p>}
          <textarea
            data-testid="hanging-json"
            style={area}
            value={text}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              request.current++;
              setChecked(null);
            }}
          />
          {checked?.kind === "errors" && (
            <ul style={errorList} data-testid="hanging-errors">
              {checked.errors.map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
          {checked?.kind === "loading" && <p>{t("viewer2d.hanging.loading")}</p>}
          {checked?.kind === "load-failed" && (
            <p style={errorText} data-testid="hanging-errors">{t("viewer2d.hanging.loadFailed", { detail: checked.detail })}</p>
          )}
          {checked?.kind === "plan" && checked.plan.ok === false && (
            <p style={errorText} data-testid="hanging-reject">
              {t(checked.plan.reason === "no-series" ? "viewer2d.hanging.noSeries" : "viewer2d.hanging.noMatch")}
            </p>
          )}
          {checked?.kind === "plan" && checked.plan.ok && (
            <div data-testid="hanging-preview">
              <p style={lead}>
                {t("viewer2d.hanging.preview", {
                  name: checked.protocol.name,
                  n: checked.plan.series.length,
                  rows: checked.plan.rows || t("viewer2d.layout.auto"),
                  cols: checked.plan.cols || t("viewer2d.layout.auto"),
                })}
              </p>
              <ol style={seriesList}>
                {checked.plan.series.map((s) => (
                  <li key={s.seriesInstanceUid} data-testid="hanging-preview-series" data-series-uid={s.seriesInstanceUid}>
                    {`#${s.seriesNumber ?? "—"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`}
                  </li>
                ))}
              </ol>
              {checked.plan.unfilledSlots.length > 0 && (
                <p style={notice} data-testid="hanging-unfilled">
                  {t("viewer2d.hanging.unfilled", { slots: checked.plan.unfilledSlots.map((i) => i + 1).join(", ") })}
                </p>
              )}
              <p style={notice} data-testid="hanging-closing">{t("viewer2d.hanging.closing", { n: closingCount })}</p>
              {transientCount > 0 && (
                <p style={errorText} data-testid="hanging-transient">{t("viewer2d.hanging.transient", { n: transientCount })}</p>
              )}
            </div>
          )}
          {plan && plan.nonImageCount > 0 && (
            <p style={notice} data-testid="hanging-nonimage">{t("viewer2d.hanging.nonImage", { n: plan.nonImageCount })}</p>
          )}
        </div>
        <div style={buttons}>
          <button style={btn} onClick={onClose} data-testid="hanging-cancel">{t("common.cancel")}</button>
          <button
            style={btn}
            onClick={() => void check(text)}
            disabled={text.trim() === "" || checked?.kind === "loading"}
            data-testid="hanging-check"
          >{t("viewer2d.hanging.check")}</button>
          <button
            style={{ ...btn, ...(plan?.ok ? primary : null) }}
            disabled={!plan?.ok}
            onClick={() => { if (plan?.ok) onApply({ series: plan.series, rows: plan.rows, cols: plan.cols }); }}
            data-testid="hanging-apply"
          >{t("viewer2d.layout.apply")}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000,
};
const panel: React.CSSProperties = {
  width: 560, maxWidth: "92vw", maxHeight: "90vh", display: "flex", flexDirection: "column",
  background: "#fff", borderRadius: 6, boxShadow: "0 8px 32px rgba(0,0,0,0.35)", overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
};
const title: React.CSSProperties = { padding: "10px 16px", background: "#0b5cad", color: "#fff", fontSize: 13, fontWeight: 600 };
const body: React.CSSProperties = { padding: "14px 16px", fontSize: 12, color: "#22303d", overflowY: "auto" };
const lead: React.CSSProperties = { margin: "0 0 8px" };
const select: React.CSSProperties = { width: "100%", marginBottom: 8, fontSize: 12 };
const area: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 180, fontFamily: "monospace", fontSize: 12, resize: "vertical",
};
const errorList: React.CSSProperties = { color: "#a4262c", margin: "8px 0 0", paddingLeft: 18 };
const errorText: React.CSSProperties = { color: "#a4262c", margin: "8px 0 0" };
const seriesList: React.CSSProperties = { margin: 0, paddingLeft: 20 };
const notice: React.CSSProperties = { margin: "8px 0 0", color: "#8a4b00" };
const buttons: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid #dfe6ee" };
const btn: React.CSSProperties = {
  padding: "5px 14px", fontSize: 12, border: "1px solid #b9c6d4", borderRadius: 4, background: "#fff", cursor: "pointer",
};
const primary: React.CSSProperties = { background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
