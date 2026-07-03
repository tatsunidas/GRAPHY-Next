/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import {
  echoDicom,
  fetchRemoteAes,
  fetchSeries,
  fetchStudies,
  sendDicom,
  type RemoteAe,
  type SendSelection,
  type Series,
  type Study,
} from "../api";
import { useI18n } from "../i18n/i18n";

/**
 * DICOM Send: MainScreen で選択中のスタディ<b>の患者</b>のスタディ/シリーズをツリー表示し、
 * 選択シリーズをリモート AE へ C-STORE（DICOM Send）する。
 *
 * 送信先は設定済みリモート AE（{@code graphy.dicom.remote-aes}）からの選択、または手動入力
 * （AE タイトル / ホスト / ポート / TLS）。送信前に C-ECHO で疎通確認できる。
 * 粒度は Export と同じく<b>シリーズ</b>（スタディのチェックは配下シリーズの一括トグル）。
 */
export function SendDialog({
  open,
  onClose,
  study,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
}) {
  const { t } = useI18n();

  // 対象患者のスタディ/シリーズツリー（ExportDialog と同構造）
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [seriesByStudy, setSeriesByStudy] = useState<Map<string, Series[]>>(new Map());
  const [expandedStudies, setExpandedStudies] = useState<Set<string>>(new Set());
  const [checkedSeries, setCheckedSeries] = useState<Set<string>>(new Set());
  const seriesStudy = useRef<Map<string, string>>(new Map());

  // 送信先
  const [remoteAes, setRemoteAes] = useState<RemoteAe[]>([]);
  const [selectedAe, setSelectedAe] = useState<string>(""); // "" = 手動入力
  const [aeTitle, setAeTitle] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("104");
  const [tls, setTls] = useState(false);

  const [busy, setBusy] = useState(false);
  const [echoing, setEchoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const patientId = study?.patientId ?? null;
  const patientName = study?.patientName ?? null;

  // 開いた時／対象患者が変わった時にツリーを初期化し、選択スタディの患者の全スタディを読み込む。
  useEffect(() => {
    if (!open || !patientId) return;
    setStudies(null);
    setSeriesByStudy(new Map());
    setExpandedStudies(new Set());
    setCheckedSeries(new Set());
    seriesStudy.current = new Map();
    setError(null);
    setInfo(null);

    let cancelled = false;
    fetchStudies({ patientId })
      .then(async (sts) => {
        if (cancelled) return;
        setStudies(sts);
        // 選択中スタディは展開＋全シリーズ初期チェック（その場で送信できる状態にする）。
        if (study) {
          try {
            const series = await fetchSeries(study.studyInstanceUid);
            if (cancelled) return;
            for (const s of series) seriesStudy.current.set(s.seriesInstanceUid, study.studyInstanceUid);
            setSeriesByStudy((m) => new Map(m).set(study.studyInstanceUid, series));
            setExpandedStudies(new Set([study.studyInstanceUid]));
            setCheckedSeries(new Set(series.map((s) => s.seriesInstanceUid)));
          } catch {
            // 先読み失敗は無視（展開時に再取得される）
          }
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, patientId, study]);

  // 設定済みリモート AE の読み込み（ダイアログを開くたび）。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchRemoteAes()
      .then((aes) => {
        if (cancelled) return;
        setRemoteAes(aes);
        if (aes.length > 0) {
          applyAe(aes[0]);
          setSelectedAe(aes[0].aeTitle);
        }
      })
      .catch(() => {
        // リモート AE 未設定でも手動入力で送信できる。
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const applyAe = (ae: RemoteAe) => {
    setAeTitle(ae.aeTitle);
    setHost(ae.host);
    setPort(String(ae.port));
    setTls(ae.tls);
  };

  const onSelectAe = (val: string) => {
    setSelectedAe(val);
    const ae = remoteAes.find((a) => a.aeTitle === val);
    if (ae) applyAe(ae);
  };

  const loadSeries = async (studyUid: string): Promise<Series[]> => {
    const cached = seriesByStudy.get(studyUid);
    if (cached) return cached;
    const series = await fetchSeries(studyUid);
    for (const s of series) seriesStudy.current.set(s.seriesInstanceUid, studyUid);
    setSeriesByStudy((m) => new Map(m).set(studyUid, series));
    return series;
  };

  const toggleExpand = async (studyUid: string) => {
    const next = new Set(expandedStudies);
    if (next.has(studyUid)) {
      next.delete(studyUid);
    } else {
      next.add(studyUid);
      try {
        await loadSeries(studyUid);
      } catch (e) {
        setError(String(e));
      }
    }
    setExpandedStudies(next);
  };

  const toggleSeries = (seriesUid: string, studyUid: string) => {
    seriesStudy.current.set(seriesUid, studyUid);
    const cs = new Set(checkedSeries);
    if (cs.has(seriesUid)) cs.delete(seriesUid);
    else cs.add(seriesUid);
    setCheckedSeries(cs);
  };

  const studyCheckState = (studyUid: string): "all" | "some" | "none" => {
    const series = seriesByStudy.get(studyUid);
    if (!series || series.length === 0) return "none";
    const n = series.filter((s) => checkedSeries.has(s.seriesInstanceUid)).length;
    return n === 0 ? "none" : n === series.length ? "all" : "some";
  };

  const toggleStudy = async (studyUid: string) => {
    let series = seriesByStudy.get(studyUid);
    if (!series) {
      try {
        series = await loadSeries(studyUid);
        setExpandedStudies((s) => new Set(s).add(studyUid));
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    const cs = new Set(checkedSeries);
    const allChecked = series.every((s) => cs.has(s.seriesInstanceUid));
    for (const s of series) {
      seriesStudy.current.set(s.seriesInstanceUid, studyUid);
      if (allChecked) cs.delete(s.seriesInstanceUid);
      else cs.add(s.seriesInstanceUid);
    }
    setCheckedSeries(cs);
  };

  const buildSelections = (): SendSelection[] => {
    const byStudy = new Map<string, string[]>();
    for (const seriesUid of checkedSeries) {
      const studyUid = seriesStudy.current.get(seriesUid);
      if (!studyUid) continue;
      if (!byStudy.has(studyUid)) byStudy.set(studyUid, []);
      byStudy.get(studyUid)!.push(seriesUid);
    }
    return [...byStudy].map(([studyUid, seriesUids]) => ({ studyUid, seriesUids }));
  };

  const destReady = host.trim() !== "" && aeTitle.trim() !== "" && /^\d+$/.test(port.trim());

  const runEcho = async () => {
    if (!destReady) return;
    setEchoing(true);
    setError(null);
    setInfo(null);
    try {
      const r = await echoDicom({ host: host.trim(), port: Number(port), calledAet: aeTitle.trim(), tls });
      if (r.success) {
        setInfo(t("send.echo.ok", { ms: r.elapsedMs }));
      } else {
        setError(t("send.echo.fail", { message: r.message }));
      }
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setEchoing(false);
    }
  };

  const run = async () => {
    const selections = buildSelections();
    if (selections.length === 0 || !destReady) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await sendDicom({
        selections,
        host: host.trim(),
        port: Number(port),
        calledAet: aeTitle.trim(),
        tls,
      });
      if (r.failed > 0) {
        setError(t("send.result.partial", { sent: r.sent, total: r.total, failed: r.failed }));
        if (r.messages.length > 0) setInfo(r.messages.slice(0, 5).join(" / "));
      } else {
        setInfo(t("send.result.ok", { sent: r.sent }));
      }
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const selectedSeriesCount = checkedSeries.size;
  const canSend = !busy && selectedSeriesCount > 0 && destReady;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("send.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {/* 対象患者ヘッダ */}
        <div style={patientBar}>
          <span style={{ fontWeight: 700 }}>{patientName || "—"}</span>
          <span style={{ color: "#8a98a6", fontSize: 12 }}> {patientId}</span>
        </div>

        {/* スタディ/シリーズツリー */}
        <div style={treePane}>
          {!studies && <div style={{ color: "#888" }}>{t("common.loading")}</div>}
          {studies?.length === 0 && <div style={{ color: "#888" }}>{t("study.empty")}</div>}
          {studies?.map((st) => {
            const expanded = expandedStudies.has(st.studyInstanceUid);
            const cstate = studyCheckState(st.studyInstanceUid);
            const series = seriesByStudy.get(st.studyInstanceUid);
            return (
              <div key={st.studyInstanceUid}>
                <div style={studyRow}>
                  <button style={expander} onClick={() => void toggleExpand(st.studyInstanceUid)} aria-label="expand">
                    {expanded ? "▾" : "▸"}
                  </button>
                  <TriCheckbox state={cstate} onChange={() => void toggleStudy(st.studyInstanceUid)} />
                  <span style={{ cursor: "pointer" }} onClick={() => void toggleExpand(st.studyInstanceUid)}>
                    {st.studyDate || "—"} / {st.studyDescription || "—"}
                    <span style={{ color: "#8a98a6", fontSize: 11 }}>
                      {" "}
                      {st.modality || ""} ({st.numberOfInstances})
                    </span>
                  </span>
                </div>
                {expanded && (
                  <div style={{ paddingLeft: 40 }}>
                    {!series && <div style={{ color: "#888" }}>{t("common.loading")}</div>}
                    {series?.length === 0 && <div style={{ color: "#888" }}>{t("series.empty")}</div>}
                    {series?.map((ser) => (
                      <label key={ser.seriesInstanceUid} style={seriesRow}>
                        <input
                          type="checkbox"
                          checked={checkedSeries.has(ser.seriesInstanceUid)}
                          onChange={() => toggleSeries(ser.seriesInstanceUid, st.studyInstanceUid)}
                        />
                        <span>
                          #{ser.seriesNumber ?? "—"} {ser.modality || ""} {ser.seriesDescription || "—"}
                          <span style={{ color: "#8a98a6", fontSize: 11 }}> ({ser.numberOfInstances})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 送信先 */}
        <div style={destPane}>
          <div style={destRow}>
            <label style={destLabel}>{t("send.dest")}</label>
            <select value={selectedAe} onChange={(e) => onSelectAe(e.target.value)} style={input}>
              {remoteAes.map((ae) => (
                <option key={ae.aeTitle} value={ae.aeTitle}>
                  {ae.aeTitle} ({ae.host}:{ae.port})
                </option>
              ))}
              <option value="">{t("send.dest.manual")}</option>
            </select>
          </div>
          <div style={destRow}>
            <label style={destLabel}>{t("send.aeTitle")}</label>
            <input value={aeTitle} onChange={(e) => { setAeTitle(e.target.value); setSelectedAe(""); }} style={input} placeholder="AET" />
            <label style={{ ...destLabel, marginLeft: 8 }}>{t("send.host")}</label>
            <input value={host} onChange={(e) => { setHost(e.target.value); setSelectedAe(""); }} style={{ ...input, flex: 2 }} placeholder="host" />
            <label style={{ ...destLabel, marginLeft: 8 }}>{t("send.port")}</label>
            <input value={port} onChange={(e) => { setPort(e.target.value); setSelectedAe(""); }} style={{ ...input, width: 70, flex: "none" }} placeholder="104" />
            <label style={{ ...opt, marginLeft: 8 }}>
              <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
              {t("send.tls")}
            </label>
            <button onClick={runEcho} disabled={echoing || !destReady} style={{ ...btn, marginLeft: 8 }}>
              {echoing ? t("send.echo.running") : t("send.echo")}
            </button>
          </div>
        </div>

        {/* 実行 */}
        <div style={footer}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {info && <div style={{ color: "#2e5d27", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{info}</div>}
            {error && <div style={{ color: "#b00020", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{error}</div>}
          </div>
          <span style={{ fontSize: 12, color: "#556" }}>{t("export.selectedCount", { count: selectedSeriesCount })}</span>
          <button onClick={onClose} style={btn}>
            {t("common.close")}
          </button>
          <button
            onClick={run}
            disabled={!canSend}
            style={{
              ...btn,
              background: canSend ? "#0b5cad" : "#9fb6cf",
              color: "#fff",
              cursor: canSend ? "pointer" : "default",
            }}
          >
            {busy ? t("send.running") : t("send.run")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** indeterminate を扱える 3 状態チェックボックス。 */
function TriCheckbox({ state, onChange }: { state: "all" | "some" | "none"; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === "all"} onChange={onChange} />;
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 820,
  maxWidth: "96vw",
  height: 620,
  maxHeight: "92vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const patientBar: React.CSSProperties = {
  padding: "8px 16px",
  borderBottom: "1px solid #eef1f4",
  background: "#f7f9fb",
};
const treePane: React.CSSProperties = { flex: 1, overflow: "auto", padding: "12px 16px", fontSize: 13 };
const studyRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "3px 0" };
const seriesRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0", cursor: "pointer" };
const expander: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  width: 16,
  color: "#667",
  padding: 0,
};
const destPane: React.CSSProperties = {
  borderTop: "1px solid #eef1f4",
  background: "#f7f9fb",
  padding: "10px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const destRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const destLabel: React.CSSProperties = { fontSize: 12, color: "#556", whiteSpace: "nowrap" };
const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "5px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  fontSize: 13,
};
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const opt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, whiteSpace: "nowrap" };
