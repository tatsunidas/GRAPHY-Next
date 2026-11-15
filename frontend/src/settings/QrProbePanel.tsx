/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { qrProbePlan, qrProbeRun, type FindProfile, type QrProbeResult } from "../api";
import { useI18n } from "../i18n/i18n";
import { bestFind, conclusion, findResults, isDefaultProfile, reportText, rowViews, type Msg, type Tone } from "./probeView";

export interface ProbeTarget {
  aeTitle: string;
  host: string;
  port: number;
  tls: boolean;
}

interface Props {
  target: ProbeTarget;
  /** いまの検索方式（標準なら null）。採用ボタンの文言の出し分けに使う。 */
  currentFind: FindProfile | null | undefined;
  /** 採用: 検索方式を通信先の行に書く（保存は利用者が一覧の［保存］で行う）。null は標準に戻す。 */
  onAdopt: (profile: FindProfile | null) => void;
}

const TONE_COLOR: Record<Tone, string> = { ok: "#2e7d32", warn: "#a15c00", ng: "#b00020", muted: "#8a96a3", running: "#0b5cad" };

/**
 * 通信先の「通信テスト」。① 相手につながる ② 検査を探せる ③ 画像を取り出せる（GET）
 * ④ 画像を送ってもらえる（MOVE）を、上から順に 1 段ずつ確かめて表示する。
 * ✕ の行には「次にすること」を添える。専門的な内容（status・コマンド）は「詳しく見る」に畳む。
 */
export function QrProbePanel({ target, currentFind, onAdopt }: Props) {
  const { t } = useI18n();
  const [patientId, setPatientId] = useState("");
  const [studyDate, setStudyDate] = useState("");
  const [results, setResults] = useState<QrProbeResult[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const cancel = useRef(false);
  // 設定ダイアログは背が低く、結果の行がダイアログの下に隠れる。結果が増えるたびに、末尾が見える位置まで送る。
  const endRef = useRef<HTMLDivElement | null>(null);
  const sumRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // 実行中は最新の行が見える位置へ、終わったら結論（結果の先頭）が見える位置へ。
    if (finished && sumRef.current) sumRef.current.scrollIntoView?.({ block: "start" });
    else endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [results.length, running, finished]);

  const msg = (m: Msg) => t(m.key, m.vars);

  const start = async () => {
    cancel.current = false;
    setResults([]);
    setFinished(false);
    setError(null);
    setCopied(false);
    setAdopted(false);
    const acc: QrProbeResult[] = [];
    try {
      const plan = await qrProbePlan();
      let sampleUid = "";
      for (const step of plan) {
        if (cancel.current) break;
        setRunning(step.stage);
        const r = await qrProbeRun(step.id, {
          host: target.host, port: target.port, calledAet: target.aeTitle, tls: target.tls,
          patientId: patientId.trim() || undefined, studyDate: studyDate.trim() || undefined,
          studyUid: sampleUid || undefined,
        });
        acc.push(r);
        setResults([...acc]);
        if (r.stage === "find" && r.sampleStudyUid && !sampleUid) sampleUid = r.sampleStudyUid;
        if (step.stage === "echo" && r.verdict !== "ok") break; // つながらなければ、以降は試さない
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
      setFinished(true);
    }
  };

  const rows = rowViews(results, running);
  const best = finished ? bestFind(results) : null;
  const finds = findResults(results);

  const adopt = (p: FindProfile | null) => {
    onAdopt(p);
    setAdopted(true);
  };

  const copy = async () => {
    const text = reportText(target, results);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div style={box} data-testid="probe-panel">
      <div style={{ fontSize: 13, fontWeight: 700, color: "#33404d" }}>
        {t("qrProbe.title")}：{target.aeTitle}（{target.host}:{target.port}）
      </div>
      <p style={{ fontSize: 12, color: "#6b7785", margin: "4px 0 8px" }}>{t("qrProbe.intro")}</p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
        <label style={lab}>
          <span>{t("qrProbe.patientId")}</span>
          <input style={inp} value={patientId} title={t("qrProbe.patientId.tip")} spellCheck={false}
            data-testid="probe-patient-id" onChange={(e) => setPatientId(e.target.value)} />
        </label>
        <label style={lab}>
          <span>{t("qrProbe.studyDate")}</span>
          <input style={{ ...inp, width: 230 }} value={studyDate} spellCheck={false}
            data-testid="probe-study-date" onChange={(e) => setStudyDate(e.target.value)} />
        </label>
        {running === null ? (
          <button style={primaryBtn} data-testid="probe-start" onClick={() => void start()}>
            {finished ? t("qrProbe.again") : t("qrProbe.start")}
          </button>
        ) : (
          <button style={btn} data-testid="probe-stop" onClick={() => { cancel.current = true; }}>{t("qrProbe.stop")}</button>
        )}
      </div>

      {error && <div style={{ color: "#b00020", fontSize: 12, marginBottom: 6 }}>{error}</div>}

      {finished && results.length > 0 && (
        <div ref={sumRef} style={summary} data-testid="probe-summary">
          {conclusion(results).map((m, i) => <div key={i}>{msg(m)}</div>)}
        </div>
      )}

      {(running !== null || results.length > 0) && (
        <div data-testid="probe-rows">
          {rows.map((r) => (
            <div key={r.id} style={rowBox} data-testid={`probe-row-${r.id}`} data-tone={r.tone}>
              <span style={{ ...icon, color: TONE_COLOR[r.tone] }}>{r.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#33404d" }}>{msg(r.title)}</div>
                {r.what && <div style={{ fontSize: 12, color: TONE_COLOR[r.tone] === TONE_COLOR.muted ? "#8a96a3" : "#33404d" }}>{msg(r.what)}</div>}
                {r.next && <div style={nextBox}>→ {msg(r.next)}</div>}
                {r.id === "find" && finds.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ fontSize: 12, color: "#0b5cad", cursor: "pointer" }}>{t("qrProbe.patterns")}</summary>
                    <div style={{ fontSize: 11, color: "#6b7785", margin: "2px 0 4px" }}>{t("qrProbe.patterns.tip")}</div>
                    {finds.map((f) => (
                      <div key={f.id} style={patRow} data-testid={`probe-pattern-${f.id}`}>
                        <span style={{ color: f.verdict === "ok" ? TONE_COLOR.ok : f.verdict === "ng" ? TONE_COLOR.ng : TONE_COLOR.muted, width: 16 }}>
                          {f.verdict === "ok" ? "✓" : f.verdict === "ng" ? "✕" : "–"}
                        </span>
                        <span style={{ flex: 1 }}>
                          {f.label}
                          <span style={{ color: "#6b7785" }}>
                            {" — "}
                            {f.verdict === "ok" ? t("qrProbe.pattern.ok", { count: f.count ?? 0 })
                              : f.verdict === "skipped" ? t("qrProbe.pattern.skipped", { why: f.reason ?? "" })
                              : t("qrProbe.pattern.ng")}
                            {f.verdict === "ok" && f.returnedKeys.length > 0 && ` / ${t("qrProbe.pattern.keys", { keys: f.returnedKeys.join(", ") })}`}
                          </span>
                        </span>
                        {f.verdict === "ok" && f.adopt && (
                          <button style={smallBtn} onClick={() => adopt(f.adopt)}>{t("qrProbe.pattern.adopt")}</button>
                        )}
                      </div>
                    ))}
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {finished && best && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {best.id === "find-standard" ? (
            !isDefaultProfile(currentFind) && (
              <button style={primaryBtn} data-testid="probe-adopt" onClick={() => adopt(null)}>{t("qrProbe.adopt.reset")}</button>
            )
          ) : (
            <button style={primaryBtn} data-testid="probe-adopt" onClick={() => adopt(best.adopt)}>
              {t("qrProbe.adopt.best", { label: best.label })}
            </button>
          )}
          {adopted && <span style={{ fontSize: 12, color: "#2e5d27" }} data-testid="probe-adopted">{t("qrProbe.adopt.done")}</span>}
        </div>
      )}

      {finished && results.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 12, color: "#0b5cad", cursor: "pointer" }}>{t("qrProbe.detail")}</summary>
          <div style={{ fontSize: 11, color: "#6b7785", margin: "2px 0" }}>{t("qrProbe.detail.note")}</div>
          <pre style={pre} data-testid="probe-report">{reportText(target, results)}</pre>
          <button style={smallBtn} onClick={() => void copy()}>{t("qrProbe.copy")}</button>
          {copied && <span style={{ fontSize: 12, color: "#2e5d27", marginLeft: 8 }}>{t("qrProbe.copied")}</span>}
        </details>
      )}
      <div ref={endRef} />
    </div>
  );
}

const box: React.CSSProperties = { margin: "2px 0 10px 12px", padding: "10px 12px", border: "1px solid #dfe5ec", borderRadius: 6, background: "#f8fafc" };
const lab: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "#5a6672" };
const inp: React.CSSProperties = { padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13, width: 150 };
const btn: React.CSSProperties = { padding: "5px 12px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const primaryBtn: React.CSSProperties = { padding: "5px 14px", border: "none", borderRadius: 6, background: "#0b5cad", color: "#fff", cursor: "pointer", fontSize: 13 };
const smallBtn: React.CSSProperties = { padding: "2px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12 };
const summary: React.CSSProperties = { padding: "6px 10px", marginBottom: 8, background: "#eef5fc", border: "1px solid #cfe0f2", borderRadius: 6, fontSize: 13, fontWeight: 600, color: "#1f3b57" };
const rowBox: React.CSSProperties = { display: "flex", gap: 8, padding: "6px 0", borderTop: "1px solid #e8edf2" };
const icon: React.CSSProperties = { width: 20, flex: "none", fontSize: 16, fontWeight: 700, textAlign: "center" };
const nextBox: React.CSSProperties = { fontSize: 12, color: "#7a4d00", background: "#fff7e6", borderRadius: 4, padding: "2px 6px", marginTop: 2 };
const patRow: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", fontSize: 12, padding: "2px 0" };
const pre: React.CSSProperties = { fontSize: 11, background: "#fff", border: "1px solid #e1e6ec", borderRadius: 4, padding: 6, whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" };
