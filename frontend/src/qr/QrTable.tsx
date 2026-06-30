/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  qrFindSeries,
  qrRetrieve,
  qrRetrieveStatus,
  qrStored,
  type QrSeriesRow,
  type QrStudyRow,
  type RemoteAe,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { ageAt, fmtDate, storedStatusOf, type StoredStatus } from "./qrUtil";

type JobView = { received: number; expected: number; stored: number; phase: string; done: boolean; success: boolean };

const keyOf = (studyUid: string, seriesUid?: string | null) =>
  seriesUid ? `${studyUid}|${seriesUid}` : studyUid;

/**
 * 1 つの Destination(PACS) の QR テーブル。スタディ行→展開でシリーズ行。
 * 保存済み状態列・Retrieve ボタン（取得中はプログレスバー）を持つ。
 */
export function QrTable({
  dest,
  studies,
  loading,
  error,
  hideStored,
  largeThreshold,
  onOpenInViewer,
}: {
  dest: RemoteAe;
  studies: QrStudyRow[] | null;
  loading: boolean;
  error: string | null;
  hideStored: boolean;
  largeThreshold: number;
  onOpenInViewer: (study: QrStudyRow, series?: QrSeriesRow) => void;
}) {
  const { t } = useI18n();
  const destReq = { host: dest.host, port: dest.port, calledAet: dest.aeTitle };

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seriesByStudy, setSeriesByStudy] = useState<Map<string, QrSeriesRow[]>>(new Map());
  const [stored, setStored] = useState<Map<string, number>>(new Map());
  const [jobs, setJobs] = useState<Map<string, JobView>>(new Map());

  // クエリ結果が変わったら展開・取得状況をリセットし、スタディ単位の保存済み件数を取得。
  useEffect(() => {
    setExpanded(new Set());
    setSeriesByStudy(new Map());
    setJobs(new Map());
    setStored(new Map());
    if (!studies || studies.length === 0) return;
    let cancelled = false;
    qrStored(studies.map((s) => ({ studyUid: s.studyInstanceUid })))
      .then((res) => {
        if (cancelled) return;
        setStored((prev) => {
          const m = new Map(prev);
          for (const r of res) m.set(keyOf(r.studyUid), r.storedCount);
          return m;
        });
      })
      .catch(() => { /* 保存済み判定失敗は致命でない */ });
    return () => {
      cancelled = true;
    };
  }, [studies]);

  const refreshStored = useCallback(
    async (q: { studyUid: string; seriesUid?: string | null }[]) => {
      try {
        const res = await qrStored(q);
        setStored((prev) => {
          const m = new Map(prev);
          for (const r of res) m.set(keyOf(r.studyUid, r.seriesUid), r.storedCount);
          return m;
        });
      } catch { /* 無視 */ }
    },
    [],
  );

  const toggleExpand = async (studyUid: string) => {
    const next = new Set(expanded);
    if (next.has(studyUid)) {
      next.delete(studyUid);
      setExpanded(next);
      return;
    }
    next.add(studyUid);
    setExpanded(next);
    if (!seriesByStudy.has(studyUid)) {
      try {
        const series = await qrFindSeries(destReq, studyUid);
        setSeriesByStudy((m) => new Map(m).set(studyUid, series));
        await refreshStored(series.map((se) => ({ studyUid, seriesUid: se.seriesInstanceUid })));
      } catch {
        setSeriesByStudy((m) => new Map(m).set(studyUid, []));
      }
    }
  };

  const pollRef = useRef<Map<string, number>>(new Map());
  useEffect(() => () => pollRef.current.forEach((h) => window.clearTimeout(h)), []);

  const retrieve = async (study: QrStudyRow, series: QrSeriesRow | null) => {
    const studyUid = study.studyInstanceUid;
    const seriesUid = series ? series.seriesInstanceUid : null;
    const expected = series ? series.numberOfSeriesRelatedInstances : study.numberOfStudyRelatedInstances;
    const k = keyOf(studyUid, seriesUid);
    if (expected > largeThreshold) {
      const label = series ? (series.seriesDescription || seriesUid) : (study.studyDescription || studyUid);
      if (!window.confirm(t("qr.confirmLarge", { count: expected, name: String(label) }))) return;
    }
    setJobs((m) => new Map(m).set(k, { received: 0, expected, stored: 0, phase: "retrieving", done: false, success: false }));
    try {
      const { jobId } = await qrRetrieve(destReq, studyUid, seriesUid, expected);
      const poll = async () => {
        try {
          const s = await qrRetrieveStatus(jobId);
          setJobs((m) => new Map(m).set(k, {
            received: s.received, expected: s.expected || expected, stored: s.stored,
            phase: s.phase, done: s.done, success: s.success,
          }));
          if (!s.done) {
            pollRef.current.set(k, window.setTimeout(poll, 700));
          } else {
            pollRef.current.delete(k);
            await refreshStored([{ studyUid, seriesUid }]);
            if (!seriesUid) {
              // スタディ取得後は配下シリーズの保存済みも更新（展開済みなら）。
              const ss = seriesByStudy.get(studyUid);
              if (ss) await refreshStored(ss.map((se) => ({ studyUid, seriesUid: se.seriesInstanceUid })));
            }
          }
        } catch {
          pollRef.current.delete(k);
          setJobs((m) => new Map(m).set(k, { received: 0, expected, stored: 0, phase: "error", done: true, success: false }));
        }
      };
      void poll();
    } catch (e) {
      setJobs((m) => new Map(m).set(k, { received: 0, expected, stored: 0, phase: "error", done: true, success: false }));
    }
  };

  if (loading) return <div style={pad}>{t("common.loading")}</div>;
  if (error) return <div style={{ ...pad, color: "#b00020" }}>{error}</div>;
  if (!studies) return <div style={{ ...pad, color: "#888" }}>{t("qr.notQueried")}</div>;
  if (studies.length === 0) return <div style={{ ...pad, color: "#888" }}>{t("qr.noResults")}</div>;

  const visibleStudies = hideStored
    ? studies.filter((s) => storedStatusOf(stored.get(keyOf(s.studyInstanceUid)) ?? 0, s.numberOfStudyRelatedInstances) !== "full")
    : studies;

  return (
    <div style={{ overflow: "auto", height: "100%" }}>
      <table style={table}>
        <thead>
          <tr style={headRow}>
            <Th style={{ width: 22 }} />
            <Th style={{ width: 78 }}>{t("qr.col.stored")}</Th>
            <Th style={{ width: 150 }}>{t("qr.col.retrieve")}</Th>
            <Th>{t("qr.col.studyDate")}</Th>
            <Th>{t("qr.col.patientId")}</Th>
            <Th>{t("qr.col.patientName")}</Th>
            <Th>{t("qr.col.birthDate")}</Th>
            <Th>{t("qr.col.sex")}</Th>
            <Th>{t("qr.col.age")}</Th>
            <Th>{t("qr.col.modality")}</Th>
            <Th>{t("qr.col.studyDesc")}</Th>
            <Th>{t("qr.col.series")}</Th>
          </tr>
        </thead>
        <tbody>
          {visibleStudies.map((s) => {
            const sk = keyOf(s.studyInstanceUid);
            const st = storedStatusOf(stored.get(sk) ?? 0, s.numberOfStudyRelatedInstances);
            const isOpen = expanded.has(s.studyInstanceUid);
            const series = seriesByStudy.get(s.studyInstanceUid);
            const age = ageAt(s.studyDate, s.patientBirthDate);
            return (
              <>
                <tr key={sk} style={studyRow}>
                  <Td>
                    <button style={expBtn} onClick={() => void toggleExpand(s.studyInstanceUid)} aria-label="expand">
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </Td>
                  <Td><StoredBadge status={st} t={t} /></Td>
                  <Td><RetrieveCell job={jobs.get(sk)} onClick={() => void retrieve(s, null)} onOpen={() => onOpenInViewer(s)} t={t} /></Td>
                  <Td>{fmtDate(s.studyDate)}</Td>
                  <Td>{s.patientId || ""}</Td>
                  <Td>{s.patientName || ""}</Td>
                  <Td>{fmtDate(s.patientBirthDate)}</Td>
                  <Td>{s.patientSex || ""}</Td>
                  <Td>{age != null ? age : ""}</Td>
                  <Td>{s.modality || ""}</Td>
                  <Td>{s.studyDescription || ""}</Td>
                  <Td>{s.numberOfStudyRelatedSeries || (series ? series.length : "")}</Td>
                </tr>
                {isOpen && (
                  <tr key={sk + "-se"}>
                    <td colSpan={12} style={{ padding: 0, background: "#fafbfc" }}>
                      {!series && <div style={{ ...pad, color: "#888" }}>{t("common.loading")}</div>}
                      {series && series.length === 0 && <div style={{ ...pad, color: "#888" }}>{t("qr.noSeries")}</div>}
                      {series && series.length > 0 && (
                        <table style={table}>
                          <thead>
                            <tr style={subHeadRow}>
                              <Th style={{ width: 78 }}>{t("qr.col.stored")}</Th>
                              <Th style={{ width: 150 }}>{t("qr.col.retrieve")}</Th>
                              <Th style={{ width: 60 }}>{t("qr.col.seriesNo")}</Th>
                              <Th>{t("qr.col.modality")}</Th>
                              <Th>{t("qr.col.seriesDesc")}</Th>
                              <Th>{t("qr.col.protocol")}</Th>
                              <Th>{t("qr.col.instances")}</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {series.map((se) => {
                              const k2 = keyOf(s.studyInstanceUid, se.seriesInstanceUid);
                              const st2 = storedStatusOf(stored.get(k2) ?? 0, se.numberOfSeriesRelatedInstances);
                              return (
                                <tr key={k2} style={seriesRowStyle}>
                                  <Td><StoredBadge status={st2} t={t} /></Td>
                                  <Td><RetrieveCell job={jobs.get(k2)} onClick={() => void retrieve(s, se)} onOpen={() => onOpenInViewer(s, se)} t={t} /></Td>
                                  <Td>{se.seriesNumber ?? ""}</Td>
                                  <Td>{se.modality || ""}</Td>
                                  <Td>{se.seriesDescription || ""}</Td>
                                  <Td>{se.protocolName || ""}</Td>
                                  <Td>{se.numberOfSeriesRelatedInstances || ""}</Td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StoredBadge({ status, t }: { status: StoredStatus; t: (k: string) => string }) {
  const map: Record<StoredStatus, { bg: string; fg: string }> = {
    full: { bg: "#e6f4ea", fg: "#1e7e34" },
    partial: { bg: "#fff4e5", fg: "#a85b00" },
    none: { bg: "#f1f3f5", fg: "#6b7785" },
    unknown: { bg: "#f1f3f5", fg: "#9aa4ad" },
  };
  const c = map[status];
  return <span style={{ ...badge, background: c.bg, color: c.fg }}>{t(`qr.stored.${status}`)}</span>;
}

function RetrieveCell({
  job,
  onClick,
  onOpen,
  t,
}: {
  job: JobView | undefined;
  onClick: () => void;
  onOpen: () => void;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  if (job && !job.done) {
    const pct = job.expected > 0 ? Math.min(100, Math.round(((job.phase === "storing" ? job.stored : job.received) / job.expected) * 100)) : null;
    return (
      <div style={{ width: 140 }}>
        <div style={progressOuter}>
          <div style={{ ...progressInner, width: pct == null ? "40%" : `${pct}%`, opacity: pct == null ? 0.5 : 1 }} />
        </div>
        <div style={{ fontSize: 10, color: "#667" }}>
          {t(`qr.phase.${job.phase}`)} {job.expected > 0 ? `${job.phase === "storing" ? job.stored : job.received}/${job.expected}` : ""}
        </div>
      </div>
    );
  }
  if (job && job.done && !job.success) {
    return (
      <div style={{ width: 140 }}>
        <button style={retBtn} onClick={onClick}>{t("qr.retry")}</button>
        <span style={{ color: "#b00020", fontSize: 11, marginLeft: 4 }}>✕</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 4, width: 140 }}>
      <button style={retBtn} onClick={onClick}>{t("qr.col.retrieve")}</button>
      {job && job.done && job.success && (
        <button style={openBtn} title={t("qr.openInViewer")} onClick={onOpen}>{t("qr.openInViewer")}</button>
      )}
    </div>
  );
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{ ...th, ...style }}>{children}</th>;
}
function Td({ children }: { children?: React.ReactNode }) {
  return <td style={td}>{children}</td>;
}

const pad: React.CSSProperties = { padding: "10px 14px", fontSize: 13 };
const table: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 12.5 };
const headRow: React.CSSProperties = { textAlign: "left", borderBottom: "2px solid #dde4ea", background: "#f7f9fb", position: "sticky", top: 0 };
const subHeadRow: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #e1e7ee", color: "#5a6672" };
const studyRow: React.CSSProperties = { borderBottom: "1px solid #eef1f4" };
const seriesRowStyle: React.CSSProperties = { borderBottom: "1px solid #eef1f4" };
const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 600, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "5px 8px", verticalAlign: "middle", whiteSpace: "nowrap" };
const expBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 12, color: "#667" };
const badge: React.CSSProperties = { display: "inline-block", padding: "1px 7px", borderRadius: 10, fontSize: 11, fontWeight: 600 };
const retBtn: React.CSSProperties = { padding: "3px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12 };
const openBtn: React.CSSProperties = { padding: "3px 6px", border: "1px solid #b7d3f0", borderRadius: 5, background: "#eef6ff", cursor: "pointer", fontSize: 11, color: "#0b5cad" };
const progressOuter: React.CSSProperties = { height: 8, background: "#e6eaee", borderRadius: 4, overflow: "hidden" };
const progressInner: React.CSSProperties = { height: "100%", background: "#0b5cad", transition: "width 0.3s" };
