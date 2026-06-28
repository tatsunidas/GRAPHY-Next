import { useEffect, useState } from "react";
import {
  fetchStudies,
  fetchSeries,
  fetchInstances,
  type Study,
  type Series,
  type Instance,
  type StudyFilters,
} from "./api";
import { useI18n } from "./i18n/i18n";
import { Viewer2D } from "./viewer/Viewer2D";
import { imageIdForInstance, type ViewerMode } from "./viewer/imageId";

const PAGE_SIZE = 50;

export function StudyList({
  filters,
  reloadKey,
  mode,
}: {
  filters?: StudyFilters | null;
  reloadKey?: number;
  mode: ViewerMode;
}) {
  const { t } = useI18n();
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStudy, setSelectedStudy] = useState<Study | null>(null);
  const [page, setPage] = useState(0);

  const filterKey = JSON.stringify(filters ?? null);
  useEffect(() => {
    setSelectedStudy(null);
    setPage(0);
    setError(null);
    setStudies(null);
    // filters が null = まだ検索していない（初期描画）。フェッチしない。
    if (filters == null) return;
    fetchStudies(filters)
      .then(setStudies)
      .catch((e: unknown) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, reloadKey]);

  const total = studies?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const pageStudies = studies ? studies.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE) : [];

  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>{t("study.list.title")}</h2>
        {studies && <span style={{ fontSize: 13, color: "#5a6672" }}>{t("study.list.total", { n: total })}</span>}
      </div>

      {filters == null && <div style={{ color: "#888" }}>{t("study.prompt")}</div>}
      {error && <div style={{ color: "#b00020" }}>{t("common.fetchError", { error })}</div>}
      {filters != null && !error && !studies && <div>{t("common.loading")}</div>}
      {studies && studies.length === 0 && <div style={{ color: "#666" }}>{t("study.empty")}</div>}

      {studies && studies.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
              <Th>{t("field.patientId")}</Th>
              <Th>{t("field.patientName")}</Th>
              <Th>{t("field.studyDate")}</Th>
              <Th>{t("field.description")}</Th>
              <Th>{t("field.modality")}</Th>
              <Th>{t("field.instanceCount")}</Th>
            </tr>
          </thead>
          <tbody>
            {pageStudies.map((s) => {
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
                  <Td>{s.modality || "—"}</Td>
                  <Td>{s.numberOfInstances}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {total > PAGE_SIZE && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, fontSize: 13 }}>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={current === 0} style={pageBtn}>
            ‹ {t("page.prev")}
          </button>
          <span style={{ color: "#5a6672" }}>
            {t("page.indicator", {
              from: current * PAGE_SIZE + 1,
              to: Math.min(total, current * PAGE_SIZE + PAGE_SIZE),
              total,
              page: current + 1,
              pages: pageCount,
            })}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={current >= pageCount - 1}
            style={pageBtn}
          >
            {t("page.next")} ›
          </button>
        </div>
      )}

      {selectedStudy && <SeriesNavigator study={selectedStudy} mode={mode} />}
    </section>
  );
}

const pageBtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};

function SeriesNavigator({ study, mode }: { study: Study; mode: ViewerMode }) {
  const { t } = useI18n();
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
        {t("series.title", { name: study.patientName || study.patientId || study.studyInstanceUid })}
      </h3>
      {error && <div style={{ color: "#b00020" }}>{error}</div>}
      {!error && !series && <div>{t("common.loading")}</div>}
      {series && series.length === 0 && <div style={{ color: "#666" }}>{t("series.empty")}</div>}

      {series && series.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #dde3ea" }}>
              <Th>{t("field.number")}</Th>
              <Th>{t("field.modality")}</Th>
              <Th>{t("field.description")}</Th>
              <Th>{t("field.instanceCount")}</Th>
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
        <InstanceList study={study} series={selectedSeries} mode={mode} />
      )}
    </div>
  );
}

function InstanceList({ study, series, mode }: { study: Study; series: Series; mode: ViewerMode }) {
  const { t } = useI18n();
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInstances(null);
    setError(null);
    fetchInstances(study.studyInstanceUid, series.seriesInstanceUid)
      .then(setInstances)
      .catch((e: unknown) => setError(String(e)));
  }, [study.studyInstanceUid, series.seriesInstanceUid]);

  const first = instances && instances.length > 0 ? instances[0] : null;
  const seriesImageIds =
    instances && mode === "standalone"
      ? instances.map((inst) => imageIdForInstance("standalone", inst.sopInstanceUid))
      : undefined;

  return (
    <div style={{ marginTop: 10, color: "#445" }}>
      {error && <div style={{ color: "#b00020" }}>{error}</div>}
      {!error && !instances && <div>{t("common.loading")}</div>}
      {instances && (
        <div style={{ fontSize: 12 }}>
          {t("instance.count", { n: instances.length })}
          {instances.length > 0 &&
            " " +
              t("instance.range", {
                from: instances[0].instanceNumber ?? "?",
                to: instances[instances.length - 1].instanceNumber ?? "?",
              })}
        </div>
      )}

      {/* 2D ビューア（骨組み）: シリーズ先頭の 1 枚を表示。スタック/ツールは次スコープ。 */}
      {first && mode === "standalone" && (
        <div style={{ marginTop: 10, maxWidth: 820 }}>
          <Viewer2D
            imageId={imageIdForInstance("standalone", first.sopInstanceUid)}
            seriesImageIds={seriesImageIds}
          />
        </div>
      )}
      {first && mode === "web" && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#8a6d3b" }}>{t("viewer.webTodo")}</div>
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
