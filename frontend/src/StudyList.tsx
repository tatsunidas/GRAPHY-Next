import { useEffect, useState } from "react";
import {
  fetchStudies,
  fetchSeries,
  fetchInstances,
  type Study,
  type Series,
  type Instance,
} from "./api";

export function StudyList() {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStudy, setSelectedStudy] = useState<Study | null>(null);

  useEffect(() => {
    fetchStudies()
      .then(setStudies)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>スタディ一覧</h2>

      {error && <div style={{ color: "#b00020" }}>取得に失敗しました: {error}</div>}
      {!error && !studies && <div>読み込み中…</div>}
      {studies && studies.length === 0 && (
        <div style={{ color: "#666" }}>スタディがありません（受信/取り込み後に表示されます）。</div>
      )}

      {studies && studies.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
              <Th>患者ID</Th>
              <Th>患者名</Th>
              <Th>検査日</Th>
              <Th>説明</Th>
              <Th>枚数</Th>
            </tr>
          </thead>
          <tbody>
            {studies.map((s) => {
              const selected = s.studyInstanceUid === selectedStudy?.studyInstanceUid;
              return (
                <tr
                  key={s.studyInstanceUid}
                  onClick={() => setSelectedStudy(selected ? null : s)}
                  style={{
                    borderBottom: "1px solid #eee",
                    cursor: "pointer",
                    background: selected ? "#eaf3fb" : "transparent",
                  }}
                >
                  <Td>{s.patientId || "—"}</Td>
                  <Td>{s.patientName || "—"}</Td>
                  <Td>{formatDate(s.studyDate)}</Td>
                  <Td>{s.studyDescription || "—"}</Td>
                  <Td>{s.numberOfInstances}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selectedStudy && <SeriesNavigator study={selectedStudy} />}
    </section>
  );
}

function SeriesNavigator({ study }: { study: Study }) {
  const [series, setSeries] = useState<Series[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);

  useEffect(() => {
    setSeries(null);
    setSelectedSeries(null);
    setError(null);
    fetchSeries(study.studyInstanceUid)
      .then(setSeries)
      .catch((e: unknown) => setError(String(e)));
  }, [study.studyInstanceUid]);

  return (
    <div style={{ marginTop: 16, padding: "12px 14px", background: "#f7f9fb", borderRadius: 6 }}>
      <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>
        シリーズ（{study.patientName || study.patientId || study.studyInstanceUid}）
      </h3>
      {error && <div style={{ color: "#b00020" }}>{error}</div>}
      {!error && !series && <div>読み込み中…</div>}
      {series && series.length === 0 && <div style={{ color: "#666" }}>シリーズがありません。</div>}

      {series && series.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #dde3ea" }}>
              <Th>#</Th>
              <Th>モダリティ</Th>
              <Th>説明</Th>
              <Th>枚数</Th>
            </tr>
          </thead>
          <tbody>
            {series.map((se) => {
              const selected = se.seriesInstanceUid === selectedSeries?.seriesInstanceUid;
              return (
                <tr
                  key={se.seriesInstanceUid}
                  onClick={() => setSelectedSeries(selected ? null : se)}
                  style={{
                    borderBottom: "1px solid #eef1f4",
                    cursor: "pointer",
                    background: selected ? "#e1ecf6" : "transparent",
                  }}
                >
                  <Td>{se.seriesNumber ?? "—"}</Td>
                  <Td>{se.modality || "—"}</Td>
                  <Td>{se.seriesDescription || "—"}</Td>
                  <Td>{se.numberOfInstances}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selectedSeries && (
        <InstanceList study={study} series={selectedSeries} />
      )}
    </div>
  );
}

function InstanceList({ study, series }: { study: Study; series: Series }) {
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInstances(null);
    setError(null);
    fetchInstances(study.studyInstanceUid, series.seriesInstanceUid)
      .then(setInstances)
      .catch((e: unknown) => setError(String(e)));
  }, [study.studyInstanceUid, series.seriesInstanceUid]);

  return (
    <div style={{ marginTop: 10, color: "#445" }}>
      {error && <div style={{ color: "#b00020" }}>{error}</div>}
      {!error && !instances && <div>読み込み中…</div>}
      {instances && (
        <div style={{ fontSize: 12 }}>
          インスタンス {instances.length} 件
          {instances.length > 0 &&
            `（#${instances[0].instanceNumber ?? "?"} 〜 #${instances[instances.length - 1].instanceNumber ?? "?"}）`}
          {/* 次フェーズ: ここから Cornerstone3D ビューポートで表示 */}
        </div>
      )}
    </div>
  );
}

function formatDate(d: string | null): string {
  if (!d || d.length !== 8) return d || "—";
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "6px 10px", color: "#666", fontWeight: 600 }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "6px 10px" }}>{children}</td>;
}
