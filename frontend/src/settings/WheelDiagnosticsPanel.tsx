/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Settings＞ビューア の末尾: ホイール診断（読み取りだけ）。
// 灰色の枠の上でホイールを回すと、deltaY・deltaMode・間隔と、ビューアと同じ `createWheelStepper` が数えたスライス数を表に出す。
// **設定は変えない・何も保存しない・外へ送らない**（コピーは利用者の操作のみ）。viewer/wheelDiagnostics.ts を参照。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { formatWheelReport, summarizeWheelLog, type WheelSample } from "../viewer/wheelDiagnostics";
import { createWheelStepper } from "../viewer/wheelScroll";

const MAX_KEPT = 500;
const SHOWN = 40;

export function WheelDiagnosticsPanel() {
  const { t } = useI18n();
  const padRef = useRef<HTMLDivElement | null>(null);
  const stepperRef = useRef(createWheelStepper());
  const [log, setLog] = useState<{ samples: WheelSample[]; steps: number[] }>({ samples: [], steps: [] });
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");

  useEffect(() => {
    const el = padRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // 枠の上でだけ。ダイアログがスクロールしない
      const step = stepperRef.current(e.deltaY, e.deltaMode, e.timeStamp);
      setLog((prev) => {
        const samples = [...prev.samples, { t: e.timeStamp, dy: e.deltaY, mode: e.deltaMode }].slice(-MAX_KEPT);
        const steps = [...prev.steps, step].slice(-MAX_KEPT);
        return { samples, steps };
      });
      setCopied("");
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const summary = useMemo(() => summarizeWheelLog(log.samples, log.steps), [log]);
  const report = useMemo(
    () =>
      formatWheelReport(summary, {
        platform: typeof navigator !== "undefined" ? navigator.platform : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      }),
    [summary],
  );

  const clear = useCallback(() => {
    stepperRef.current = createWheelStepper(); // 端数も捨てる
    setLog({ samples: [], steps: [] });
    setCopied("");
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied("ok");
    } catch {
      setCopied("fail"); // 下の読み取り専用の欄を選択してコピーしてもらう
    }
  }, [report]);

  const shown = log.samples.map((s, i) => ({ s, step: log.steps[i], gap: i > 0 ? s.t - log.samples[i - 1].t : null })).slice(-SHOWN).reverse();

  return (
    <details data-testid="wheel-diag" style={box}>
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14 }}>{t("wheelDiag.title")}</summary>
      <p style={note}>{t("wheelDiag.intro")}</p>
      <div
        ref={padRef}
        data-testid="wheel-diag-pad"
        style={pad}
        data-count={summary.count}
        data-slices={summary.totalSlices}
      >
        {t("wheelDiag.pad")}
      </div>
      <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
        <button type="button" data-testid="wheel-diag-clear" onClick={clear} style={btn}>
          {t("wheelDiag.clear")}
        </button>
        <button type="button" data-testid="wheel-diag-copy" onClick={copy} style={btn}>
          {t("wheelDiag.copy")}
        </button>
        {copied === "ok" && <span style={{ color: "#0a7a3a", fontSize: 12.5 }}>{t("wheelDiag.copied")}</span>}
        {copied === "fail" && <span style={{ color: "#a33", fontSize: 12.5 }}>{t("wheelDiag.copyFailed")}</span>}
      </div>
      <div data-testid="wheel-diag-summary" data-count={summary.count} data-slices={summary.totalSlices} style={{ fontSize: 12.5, color: "#223" }}>
        {t("wheelDiag.summary", { count: summary.count, slices: summary.totalSlices })}
      </div>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>deltaY</th>
            <th style={th}>deltaMode</th>
            <th style={th}>{t("wheelDiag.col.gap")}</th>
            <th style={th}>{t("wheelDiag.col.step")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ s, step, gap }, i) => (
            <tr key={`${s.t}-${i}`} data-testid="wheel-diag-row" data-dy={s.dy} data-mode={s.mode} data-step={step}>
              <td style={td}>{s.dy}</td>
              <td style={td}>{s.mode}</td>
              <td style={td}>{gap === null ? "—" : Math.round(gap * 10) / 10}</td>
              <td style={td}>{step}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <textarea data-testid="wheel-diag-report" readOnly value={report} rows={10} style={ta} onFocus={(e) => e.currentTarget.select()} />
    </details>
  );
}

const box: React.CSSProperties = { marginTop: 18, border: "1px solid #dde3ea", borderRadius: 8, padding: "10px 12px", background: "#fafbfc" };
const note: React.CSSProperties = { color: "#445", fontSize: 12.5, margin: "8px 0" };
const pad: React.CSSProperties = {
  height: 90,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#e9edf2",
  border: "2px dashed #9fb0c3",
  borderRadius: 8,
  color: "#334",
  fontSize: 13,
  userSelect: "none",
};
const btn: React.CSSProperties = { padding: "4px 12px", border: "1px solid #b0bccb", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12.5 };
const table: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 12.5, marginTop: 8 };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "2px solid #dde3ea", padding: "3px 8px", color: "#556", whiteSpace: "nowrap" };
const td: React.CSSProperties = { borderBottom: "1px solid #eef1f4", padding: "3px 8px" };
const ta: React.CSSProperties = { width: "100%", marginTop: 10, fontFamily: "monospace", fontSize: 12, boxSizing: "border-box" };
