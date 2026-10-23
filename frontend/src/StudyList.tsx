/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  instanceDocumentUrl,
  ENCAPSULATED_PDF_SOP_CLASS,
  isVideoInstance,
  type Study,
  type Series,
  type StudyFilters,
  type StudyReportCount,
} from "./api";
import { useStudies } from "./hooks/useStudies";
import { useSeries } from "./hooks/useSeries";
import { useInstances } from "./hooks/useInstances";
import { useI18n } from "./i18n/i18n";
import { SeriesViewer } from "./viewer/SeriesViewer";
import { useToolPanelDefault } from "./viewer/toolPanelDefault";
import { seriesHeadingName } from "./seriesHeading";
import { LIST_LAYOUTS, isTreeOpen, pickFirstImageSeries, type ListLayout } from "./mainscreen/listLayout";
import { imageCount } from "./imageCount";
import { classifySeriesRenderability, type SeriesRenderability } from "./viewer/seriesRenderable";
import { VideoViewer } from "./viewer/VideoViewer";
import { type ViewerMode } from "./viewer/imageId";
import { useTableSort, applySort, sortIndicator, type SortState, type Accessor } from "./tableSort";

const PAGE_SIZE = 50;

// スタディ表の列ソート用アクセサ（numberOfInstances は数値=自然な数値順）。
/** スタディが持つモダリティの列挙（無ければ従来の単一値へフォールバック）。 */
const studyModalities = (s: Study): string =>
  s.modalities && s.modalities.length > 0 ? s.modalities.join(" / ") : (s.modality ?? "");

const STUDY_SORT: Record<string, Accessor<Study>> = {
  patientId: (s) => s.patientId,
  patientName: (s) => s.patientName,
  studyDate: (s) => s.studyDate,
  studyDescription: (s) => s.studyDescription,
  modality: (s) => studyModalities(s),
  numberOfInstances: (s) => imageCount(s),
};

export function StudyList({
  filters,
  reloadKey,
  connecting = false,
  mode,
  onSelectStudy,
  onSelectSeries,
  previewHost,
  layout,
  onLayoutChange,
  seriesHost,
}: {
  filters?: StudyFilters | null;
  reloadKey?: number;
  /** backend にまだつながっていない（起動の待ち）。検索せず「接続中…」を出す。 */
  connecting?: boolean;
  mode: ViewerMode;
  onSelectStudy?: (s: Study | null) => void;
  onSelectSeries?: (s: Series | null) => void;
  /**
   * シリーズプレビューの描画先（メイン画面下部のドック）。undefined なら一覧の末尾に置く（従来どおり）。
   * null はドックが閉じている状態で、プレビューは描かない（読み込まない）。
   */
  previewHost?: HTMLElement | null;
  /** 一覧の表示形式。undefined なら切り替えを出さず従来の表（table）。 */
  layout?: ListLayout;
  onLayoutChange?: (l: ListLayout) => void;
  /**
   * シリーズ一覧の描画先（上下 2 ペインのときの下のペイン）。undefined なら一覧の末尾に置く（従来どおり）。
   * null はペインがまだ無い間で、シリーズ一覧は描かない。
   */
  seriesHost?: HTMLElement | null;
}) {
  const { t } = useI18n();
  // 取得は hooks/useStudies に集約（モバイルシェルと共有。fw/mobile-ui-design.md §3.5）。
  const { studies, reportCounts, error } = useStudies(connecting ? null : filters, { reloadKey, withReportCounts: true });
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

  // 検索条件・再読込キーが変わったら選択とページを初期化する（取得自体は useStudies が行う）。
  const filterKey = JSON.stringify(filters ?? null);
  useEffect(() => {
    setSelectedStudy(null);
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, reloadKey]);

  // ページ分割の前に全件ソートする（ページ内だけの並び替えにならないように）。
  const sortedStudies = applySort(studies ?? [], sort, STUDY_SORT);
  const total = sortedStudies.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const pageStudies = studies ? sortedStudies.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE) : [];
  // ツリー: 選んだ検査の行の直下にシリーズを開く。選んだ検査が別のページにあるときは行が無いので、末尾に出す。
  const treeOpen = isTreeOpen(layout ?? "table", selectedStudy?.studyInstanceUid, pageStudies.map((s) => s.studyInstanceUid));

  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>{t("study.list.title")}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {layout && onLayoutChange && (
            <div role="group" aria-label={t("main.layout.label")} style={{ display: "flex" }}>
              {LIST_LAYOUTS.map((l, i) => (
                <button
                  key={l}
                  type="button"
                  data-testid={`list-layout-${l}`}
                  aria-pressed={layout === l}
                  onClick={() => onLayoutChange(l)}
                  style={{
                    ...pageBtn,
                    borderRadius: i === 0 ? "6px 0 0 6px" : i === LIST_LAYOUTS.length - 1 ? "0 6px 6px 0" : 0,
                    marginLeft: i === 0 ? 0 : -1,
                    background: layout === l ? "#e1ecf6" : "#fff",
                    fontWeight: layout === l ? 600 : 400,
                  }}
                >
                  {t(`main.layout.${l}`)}
                </button>
              ))}
            </div>
          )}
          {studies && <span style={{ fontSize: 13, color: "#5a6672" }}>{t("study.list.total", { n: total })}</span>}
        </div>
      </div>

      {connecting && <div style={{ color: "#888" }}>{t("app.connecting")}</div>}
      {!connecting && filters == null && <div style={{ color: "#888" }}>{t("study.prompt")}</div>}
      {error && <div style={{ color: "#b00020" }}>{t("common.fetchError", { error })}</div>}
      {!connecting && filters != null && !error && !studies && <div>{t("common.loading")}</div>}
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
              <Th>{t("field.report")}</Th>
            </tr>
          </thead>
          <tbody>
            {pageStudies.map((s) => {
              const selected = s.studyInstanceUid === selectedStudy?.studyInstanceUid;
              return (
                <Fragment key={s.studyInstanceUid}>
                <tr
                  data-testid={`study-row-${s.studyInstanceUid}`}
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
                  <Td>{studyModalities(s) || "—"}</Td>
                  <Td>{imageCount(s)}</Td>
                  <Td><ReportBadge count={reportCounts[s.studyInstanceUid]} /></Td>
                </tr>
                {selected && treeOpen && (
                  <tr data-testid="series-tree-row">
                    <td colSpan={7} style={{ padding: 0 }}>
                      <SeriesNavigator
                        key={s.studyInstanceUid}
                        study={s}
                        mode={mode}
                        onSelectSeries={onSelectSeries}
                        previewHost={previewHost}
                        tree
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
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

      {selectedStudy && !treeOpen && (
        <SeriesNavigator
          key={selectedStudy.studyInstanceUid}
          study={selectedStudy}
          mode={mode}
          onSelectSeries={onSelectSeries}
          previewHost={previewHost}
          seriesHost={seriesHost}
        />
      )}
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
  previewHost,
  seriesHost,
  tree = false,
}: {
  study: Study;
  /** ツリー形式: 検査の行の直下に子ノードとして描く。 */
  tree?: boolean;
  mode: ViewerMode;
  onSelectSeries?: (s: Series | null) => void;
  /** シリーズ一覧の描画先。要素のとき（上下 2 ペイン）は、検査を選んだら最初の画像シリーズを自動で選ぶ。 */
  seriesHost?: HTMLElement | null;
  /**
   * シリーズプレビューの描画先（メイン画面下部のドック）。undefined なら一覧の末尾に置く（従来どおり）。
   * null はドックが閉じている状態で、プレビューは描かない（読み込まない）。
   */
  previewHost?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { series, error } = useSeries(study.studyInstanceUid);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);

  const headingName = seriesHeadingName(selectedSeries);

  const handleSelectSeries = (se: Series | null) => {
    setSelectedSeries(se);
    onSelectSeries?.(se);
  };

  // スタディが変わったらシリーズ選択を捨てる（取得自体は useSeries が行う）。
  useEffect(() => {
    setSelectedSeries(null);
  }, [study.studyInstanceUid]);

  // 上下 2 ペインのときは、検査を選んだら最初の画像シリーズを開く（スクロールもクリックも要らない）。
  // 1 検査につき 1 回だけ（利用者が選択を外したあとに勝手に選び直さない）。親が key で検査ごとに作り直す。
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!(seriesHost || tree) || !series || autoPicked.current) return;
    autoPicked.current = true;
    const first = pickFirstImageSeries(series);
    if (first) handleSelectSeries(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesHost, tree, series]);

  // 上下 2 ペイン: ペインが出来るまで（null）は描かない。ペインがあれば portal で描く。undefined は従来どおり一覧の末尾。
  if (seriesHost === null) return null;
  const panelStyle: React.CSSProperties = tree
    ? { margin: "2px 0 8px 22px", padding: "6px 12px", background: "#f7f9fb", borderLeft: "3px solid #9fbfdc" }
    : seriesHost
      ? { padding: "8px 14px", background: "#f7f9fb" }
      : { marginTop: 16, padding: "12px 14px", background: "#f7f9fb", borderRadius: 6 };
  const panel = (
    <div data-testid="series-panel" style={panelStyle}>
      <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>
        {headingName ? t("series.title", { name: headingName }) : t("series.titleNone")}
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
                  data-testid={`series-row-${se.seriesInstanceUid}`}
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
                  <Td>{imageCount(se)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selectedSeries && (
        <InstanceList study={study} series={selectedSeries} mode={mode} previewHost={previewHost} />
      )}
    </div>
  );
  return seriesHost ? createPortal(panel, seriesHost) : panel;
}

/** instances 未取得の間は「開ける」として扱い、ビューア表示は hasImages 側で抑える。 */
const RENDERABLE_UNKNOWN: SeriesRenderability = { renderable: true, kind: null, by: null };

function InstanceList({
  study,
  series,
  mode,
  previewHost,
}: {
  study: Study;
  series: Series;
  mode: ViewerMode;
  previewHost?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { instances, error } = useInstances(study.studyInstanceUid, series.seriesInstanceUid);

  const hasImages = !!instances && instances.length > 0;
  // Encapsulated PDF はピクセルが無く 2D 画像ビューアで表示できないため、文書パネルで開く。
  const isPdf = hasImages && instances![0].sopClassUid === ENCAPSULATED_PDF_SOP_CLASS;
  // ピクセルを持たない SOP クラス（RTSTRUCT / SR / PR …）は画像ビューアで開けない。
  // 判定は代表インスタンスの SOP クラスで行う（シリーズ一覧の値より確実）。
  const nonImage = hasImages
    ? classifySeriesRenderability({ sopClassUid: instances![0].sopClassUid, modality: series.modality })
    : RENDERABLE_UNKNOWN;
  // 動画(Video Photographic/Endoscopic/Microscopic、および H.264 等で包まれたシリーズ)は
  // wadouri の画像ビューアでは表示できず、専用の VideoViewer（/rendered の video/mp4 を
  // <video> 再生）で表示する。
  const isVideo = hasImages && isVideoInstance(instances![0]);
  const toolPanelDefault = useToolPanelDefault();
  // web はピクセルを BFF(WADO-RS)経由で取得して表示（standalone と同一の StackViewport 経路）。
  const viewer =
    hasImages && instances ? (
      <SeriesViewer
        instances={instances}
        mode={mode}
        studyUid={study.studyInstanceUid}
        seriesUid={series.seriesInstanceUid}
        fillHeight
        showControls={toolPanelDefault ?? false}
      />
    ) : null;

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

      {/* 動画（Video Photographic/Endoscopic/Microscopic）: standalone は VideoViewer で再生。
          web は /rendered（索引ローカルファイル前提）が使えないため今後対応の案内。 */}
      {isVideo && instances && mode === "standalone" &&
        instances.map((inst) => (
          <div key={inst.sopInstanceUid} style={{ marginTop: 10 }}>
            {instances.length > 1 && (
              <div style={{ fontSize: 13, color: "#445" }}>🎞 #{inst.instanceNumber ?? "?"}</div>
            )}
            <VideoViewer sopInstanceUid={inst.sopInstanceUid} />
          </div>
        ))}
      {isVideo && mode !== "standalone" && (
        <div style={{ marginTop: 10, fontSize: 13, color: "#8a6d3b" }}>
          🎞 {t("video.webUnsupported")}
        </div>
      )}

      {/* ピクセルを持たないシリーズ: 画像ビューアを出さず、何であるかを説明する。
          （以前は開こうとして Cornerstone が "The pixel data is missing" で reject し、
            コンソールに未処理例外が出るだけでユーザーには無反応に見えていた。） */}
      {!nonImage.renderable && (
        <div data-testid="series-non-image-notice" style={nonImageNotice}>
          {t("series.nonImage", { kind: nonImage.kind ?? "" })}
        </div>
      )}

      {/* シリーズビューア（スライス送り・シネ・5D・オーバーレイ On/Off のコントローラ）。 */}
      {previewHost === undefined && hasImages && !isPdf && !isVideo && nonImage.renderable && instances && (
        <div style={previewBox}>{viewer}</div>
      )}
      {/* ドック（メイン画面下部）に描く。閉じている（null）間は描かない＝読み込まない。 */}
      {previewHost && hasImages && !isPdf && !isVideo && nonImage.renderable && instances &&
        createPortal(<div style={dockBox}>{viewer}</div>, previewHost)}
    </div>
  );
}

// シリーズプレビュー: 幅いっぱい、高さはウィンドウ高に追従（画像はこの枠の中央に Fit 表示。ツールは既定で畳む）。
// 240px の根拠（実測）: スクロール領域の高さは 100vh − 137px（メニュー・ツールバー・ステータスバー）で、
// その上に表・見出しが 103px 分ある。末尾までスクロールすると窓高 600/900/1200 のいずれでも
// プレビュー全体が領域内に収まる。小さい窓でも 320px は確保する。
const previewBox: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  flexDirection: "column",
  height: "max(320px, calc(100vh - 240px))",
};

// ドックの本体いっぱいに広げる（高さはドック側で決める）。
const dockBox: React.CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" };

/** ピクセルを持たないシリーズの説明ボックス（PDF / 動画の案内と同じ調子）。 */
const nonImageNotice: React.CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  color: "#8a6d3b",
};

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

/** レポート有無セル（旧 GRAPHY `ReportCellRenderer` 相当）: 確定=青●、下書きのみ=橙○、件数併記。 */
function ReportBadge({ count }: { count: StudyReportCount | undefined }) {
  const { t } = useI18n();
  if (!count || count.reportState === "none") return <span style={{ color: "#ccc" }}>—</span>;
  const isFinal = count.reportState === "report";
  const n = isFinal ? count.reportCount : count.draftCount;
  return (
    <span
      title={t(isFinal ? "study.report.final" : "study.report.draft", { count: n })}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, color: isFinal ? "#0b5cad" : "#c67c00" }}
    >
      <span style={{ fontSize: 14, lineHeight: 1 }}>{isFinal ? "●" : "○"}</span>
      <span style={{ fontSize: 12 }}>{n}</span>
    </span>
  );
}

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
