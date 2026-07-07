/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import {
  fetchStudies,
  fetchSeries,
  fetchInstances,
  instanceDocumentUrl,
  ENCAPSULATED_PDF_SOP_CLASS,
  VIDEO_PHOTOGRAPHIC_SOP_CLASS,
  type Study,
  type Series,
  type Instance,
  type StudyFilters,
} from "./api";
import { useI18n } from "./i18n/i18n";
import { SeriesViewer } from "./viewer/SeriesViewer";
import { type ViewerMode } from "./viewer/imageId";
import { useTableSort, applySort, sortIndicator, type SortState, type Accessor } from "./tableSort";

const PAGE_SIZE = 50;

// スタディ表の列ソート用アクセサ（numberOfInstances は数値=自然な数値順）。
const STUDY_SORT: Record<string, Accessor<Study>> = {
  patientId: (s) => s.patientId,
  patientName: (s) => s.patientName,
  studyDate: (s) => s.studyDate,
  studyDescription: (s) => s.studyDescription,
  modality: (s) => s.modality,
  numberOfInstances: (s) => s.numberOfInstances,
};

export function StudyList({
  filters,
  reloadKey,
  mode,
  onSelectStudy,
  onSelectSeries,
}: {
  filters?: StudyFilters | null;
  reloadKey?: number;
  mode: ViewerMode;
  onSelectStudy?: (s: Study | null) => void;
  onSelectSeries?: (s: Series | null) => void;
}) {
  const { t } = useI18n();
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStudy, setSelectedStudy] = useState<Study | null>(null);
  const [page, setPage] = useState(0);
  const { sort, toggleSort } = useTableSort();
  // ソート変更時は先頭ページへ（並び替え後の上位が見えるように）。
  const onSort = (key: string) => {
    toggleSort(key);
    setPage(0);
  };

  const handleSelectStudy = (s: Study | null) => {
    setSelectedStudy(s);
    onSelectStudy?.(s);
    onSelectSeries?.(null); // スタディ変更時はシリーズ選択をリセット
  };

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

  // ページ分割の前に全件ソートする（ページ内だけの並び替えにならないように）。
  const sortedStudies = applySort(studies ?? [], sort, STUDY_SORT);
  const total = sortedStudies.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const pageStudies = studies ? sortedStudies.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE) : [];

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
              <Th sortKey="patientId" sort={sort} onSort={onSort}>{t("field.patientId")}</Th>
              <Th sortKey="patientName" sort={sort} onSort={onSort}>{t("field.patientName")}</Th>
              <Th sortKey="studyDate" sort={sort} onSort={onSort}>{t("field.studyDate")}</Th>
              <Th sortKey="studyDescription" sort={sort} onSort={onSort}>{t("field.description")}</Th>
              <Th sortKey="modality" sort={sort} onSort={onSort}>{t("field.modality")}</Th>
              <Th sortKey="numberOfInstances" sort={sort} onSort={onSort}>{t("field.instanceCount")}</Th>
            </tr>
          </thead>
          <tbody>
            {pageStudies.map((s) => {
              const selected = s.studyInstanceUid === selectedStudy?.studyInstanceUid;
              return (
                <tr
                  key={s.studyInstanceUid}
                  onClick={() => handleSelectStudy(selected ? null : s)}
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

      {selectedStudy && <SeriesNavigator study={selectedStudy} mode={mode} onSelectSeries={onSelectSeries} />}
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

function SeriesNavigator({
  study,
  mode,
  onSelectSeries,
}: {
  study: Study;
  mode: ViewerMode;
  onSelectSeries?: (s: Series | null) => void;
}) {
  const { t } = useI18n();
  const [series, setSeries] = useState<Series[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);

  const handleSelectSeries = (se: Series | null) => {
    setSelectedSeries(se);
    onSelectSeries?.(se);
  };

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
                  onClick={() => handleSelectSeries(selected ? null : se)}
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

  const hasImages = !!instances && instances.length > 0;
  // Encapsulated PDF はピクセルが無く 2D 画像ビューアで表示できないため、文書パネルで開く。
  const isPdf = hasImages && instances![0].sopClassUid === ENCAPSULATED_PDF_SOP_CLASS;
  // 動画(Video Photographic)も wadouri の画像ビューアでは表示できない（再生は 2D Viewer 側で今後対応）。
  const isVideo = hasImages && instances![0].sopClassUid === VIDEO_PHOTOGRAPHIC_SOP_CLASS;

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

      {/* PDF（Encapsulated PDF）: 画像ビューアではなく文書として開く/保存する。 */}
      {isPdf && instances && (
        <div style={{ marginTop: 10 }}>
          {instances.map((inst) => (
            <div
              key={inst.sopInstanceUid}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}
            >
              <span style={{ fontSize: 13 }}>📄 PDF #{inst.instanceNumber ?? "?"}</span>
              <button onClick={() => window.open(instanceDocumentUrl(inst.sopInstanceUid), "_blank")} style={docBtn}>
                {t("doc.open")}
              </button>
              <a href={instanceDocumentUrl(inst.sopInstanceUid, true)} download style={docLink}>
                {t("doc.download")}
              </a>
            </div>
          ))}
        </div>
      )}

      {/* 動画（Video Photographic）: 画像ビューア非対応。再生は 2D Viewer で今後対応。 */}
      {isVideo && (
        <div style={{ marginTop: 10, fontSize: 13, color: "#8a6d3b" }}>
          🎞 {t("nondicom.video.needsFfmpeg")}
        </div>
      )}

      {/* シリーズビューア（スライス送り・シネ・5D・オーバーレイ On/Off のコントローラ）。 */}
      {hasImages && !isPdf && !isVideo && instances && (
        <div style={{ marginTop: 10, maxWidth: 900 }}>
          {/* web はピクセルを BFF(WADO-RS)経由で取得して表示（standalone と同一の StackViewport 経路）。 */}
          <SeriesViewer
            instances={instances}
            mode={mode}
            studyUid={study.studyInstanceUid}
            seriesUid={series.seriesInstanceUid}
          />
        </div>
      )}
    </div>
  );
}

const docBtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const docLink: React.CSSProperties = { fontSize: 13, color: "#0b5cad" };

function formatDate(d: string | null): string {
  if (!d || d.length !== 8) return d || "—";
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function Th({
  children,
  sortKey,
  sort,
  onSort,
}: {
  children?: React.ReactNode;
  sortKey?: string;
  sort?: SortState | null;
  onSort?: (key: string) => void;
}) {
  const clickable = !!sortKey && !!onSort;
  return (
    <th
      onClick={clickable ? () => onSort!(sortKey!) : undefined}
      style={{
        padding: "6px 10px",
        color: "#666",
        fontWeight: 600,
        whiteSpace: "nowrap",
        cursor: clickable ? "pointer" : undefined,
        userSelect: clickable ? "none" : undefined,
      }}
    >
      {children}
      {sortKey ? sortIndicator(sort ?? null, sortKey) : ""}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "6px 10px" }}>{children}</td>;
}
