/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { cancelImportJob, deleteUrlImportFile, getImportJob, submitImportJob, type AppStatus, type ImportJobStatus, type ImportResult, type Study, type Series, type StudyFilters } from "../api";
import { desktop } from "../desktopBridge";
import { droppedPaths, hasDroppedFiles } from "./droppedPaths";
import { ImportProgressBanner } from "./ImportProgressBanner";
import { runImportJob } from "./importJob";
import { importedStudiesView, type ImportedView } from "./importedView";
import { useI18n } from "../i18n/i18n";
import { StudyList } from "../StudyList";
import { PreviewDock } from "./PreviewDock";
import { LIST_LAYOUT_STORAGE_KEY, isPaneLayout, parseListLayout, type ListLayout } from "./listLayout";
import { MenuBar } from "./MenuBar";
import { Toolbar, type ToolKind } from "./Toolbar";
import { SearchPanel } from "./SearchPanel";
import { StatusBar } from "./StatusBar";
import { useImportWatchStatus } from "./useImportWatchStatus";
import { useReceiveAnonStatus } from "./useReceiveAnonStatus";
import { useComputeJobsStatus } from "./useComputeJobsStatus";
import { TagExtractorDialog } from "./TagExtractorDialog";
import { SeriesExtractorDialog } from "./SeriesExtractorDialog";
import { AnonymizerDialog } from "./AnonymizerDialog";
import { ExportDialog } from "./ExportDialog";
import { SendDialog } from "./SendDialog";
import { TagViewerDialog } from "./TagViewerDialog";
import { NonDicomImportDialog } from "./NonDicomImportDialog";
import { UrlImportDialog } from "./UrlImportDialog";
import { ReportEditorDialog } from "../report/ReportEditorDialog";
import { ReportManagerDialog } from "../report/ReportManagerDialog";
import { DoseReportDialog } from "./DoseReportDialog";
import { TaskLauncherDialog } from "./TaskLauncherDialog";
import { AlbumBar } from "../albums/AlbumBar";
import { fetchAlbumStudies } from "../albums/albumApi";
import { albumFilters, type AlbumView } from "../albums/albumView";

/**
 * アプリの土台シェル（GRAPHY の MainScreen 相当）。
 * メニュー / ツールバー / 検索パネル / STUDY ツリーテーブル / 状態・時刻表示。
 * web 版はそのままポータル画面として使う（検索→スタディ一覧→ビューア起動）。
 */
export function MainScreen({
  status,
  error,
  dbVersion = 0,
  onOpenSettings,
  onOpenDb,
  onOpenHelp,
  onOpenMobileUi,
}: {
  status: AppStatus | null;
  error: string | null;
  /** DB 管理での編集成功時にインクリメントされ、スタディ一覧を再読込する。 */
  dbVersion?: number;
  onOpenSettings: () => void;
  onOpenDb: () => void;
  onOpenHelp: () => void;
  /** モバイル UI（`#mobile`）へ手動で切り替える。web モードでのみメニューに出す。 */
  onOpenMobileUi?: () => void;
}) {
  const { t } = useI18n();
  const isStandalone = status?.mode === "standalone";
  const canImport = isStandalone && !!desktop();
  const isDemo = status?.demo === true;
  // null = まだ検索していない。SearchPanel が初期条件(今日)で onSearch を呼ぶと埋まる。
  const [filters, setFilters] = useState<StudyFilters | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 下部のプレビュー枠の DOM。閉じている間は null（StudyList はプレビューを描かない）。
  const [dockHost, setDockHost] = useState<HTMLElement | null>(null);
  // 一覧の表示形式（table=従来 / split=上下 2 ペイン / side=左右 2 ペイン / tree=選んだ検査の直下にシリーズ）。選択は保存する。
  const [listLayout, setListLayout] = useState<ListLayout>(() => {
    try {
      return parseListLayout(localStorage.getItem(LIST_LAYOUT_STORAGE_KEY));
    } catch {
      return "table";
    }
  });
  const changeListLayout = (l: ListLayout) => {
    setListLayout(l);
    try {
      localStorage.setItem(LIST_LAYOUT_STORAGE_KEY, l);
    } catch {
      // 保存できなくても表示は切り替わる
    }
  };
  // 上下 2 ペインの下のペイン（シリーズ一覧の描画先）。split・side でないときは存在しない。
  const [seriesPane, setSeriesPane] = useState<HTMLElement | null>(null);
  const importWatch = useImportWatchStatus(isStandalone);
  const receiveAnon = useReceiveAnonStatus(isStandalone);
  const computeJobsStatus = useComputeJobsStatus(isStandalone);
  // 取り込み直後は、一覧を「いま取り込んだ検査」に絞る（既定の検索条件「今日」では過去の検査が出ないため）。
  const [importedView, setImportedView] = useState<ImportedView | null>(null);
  const searchFiltersRef = useRef<StudyFilters | null>(null);
  // アルバムを表示中は、一覧をそのアルバムのスタディだけに絞る（検索・取り込み直後の絞り込みと排他）。
  const [albumView, setAlbumView] = useState<AlbumView | null>(null);
  const [albumVersion, setAlbumVersion] = useState(0);
  const onSearch = (f: StudyFilters) => {
    searchFiltersRef.current = f;
    setImportedView(null);
    setAlbumView(null);
    setFilters(f);
  };
  const openAlbum = (v: AlbumView) => {
    setImportedView(null);
    setAlbumView(v);
    setFilters(albumFilters(v.uids));
  };
  const closeAlbum = () => {
    setAlbumView(null);
    setFilters(searchFiltersRef.current);
  };
  // アルバムの中身や一覧が変わった: 一覧の選択肢を取り直し、表示中ならその所属も取り直す（消えていたら絞り込みを解く）。
  const onAlbumChanged = () => {
    setAlbumVersion((v) => v + 1);
    if (!albumView) return;
    const id = albumView.id;
    fetchAlbumStudies(id)
      .then((uids) => {
        setAlbumView((cur) => (cur && cur.id === id ? { ...cur, uids } : cur));
        setFilters(albumFilters(uids));
      })
      .catch(() => closeAlbum());
  };
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [selectedStudy, setSelectedStudy] = useState<Study | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [openTool, setOpenTool] = useState<
    | "tagExtractor"
    | "seriesExtractor"
    | "anonymizer"
    | "export"
    | "send"
    | "tagViewer"
    | "nonDicomImport"
    | "report"
    | "reportManager"
    | "dose"
    | "taskLauncher"
    | "urlImport"
    | null
  >(null);
  // URL から落とした非 DICOM のファイル。非DICOM取込をそのファイルで開き、閉じたら一時ファイルを消す
  const [urlFile, setUrlFile] = useState<{ path: string; jobId: string } | null>(null);
  // ReportManagerDialog から特定レポートを開いたときだけ設定（新規/報告ボタンからの通常オープンは null=自動解決）。
  const [reportEditorId, setReportEditorId] = useState<string | null>(null);

  // ボタン・メニューとドロップの両方から使う。取り込み中は次を受けない。
  const importingRef = useRef(false);
  // 進捗つきの取り込みジョブ（null＝取り込んでいない）と、中止の求め。
  const [importJob, setImportJob] = useState<ImportJobStatus | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false);
  // 画面が閉じられたら取り込みも止める（裏で続けない）。
  useEffect(() => () => { cancelRequested.current = true; }, []);
  const [dropActive, setDropActive] = useState(false);
  // dragenter/dragleave は子要素の出入りでも飛ぶので、入った回数で数える。
  const dragDepth = useRef(0);

  const handleImport = async () => {
    const d = desktop();
    if (!d || importingRef.current) return;
    const paths = await d.pickImportPaths();
    if (!paths || paths.length === 0) return;
    await runImport(paths);
  };

  const runImport = async (paths: string[]) => {
    if (importingRef.current) return;
    importingRef.current = true;
    try {
      await runImportOnce(paths);
    } finally {
      importingRef.current = false;
    }
  };

  const runImportOnce = async (paths: string[]) => {
    setImportMsg(null);
    cancelRequested.current = false;
    setCancelling(false);
    try {
      const job = await runImportJob(
        { submit: submitImportJob, get: getImportJob, cancel: cancelImportJob },
        paths,
        setImportJob,
        () => cancelRequested.current,
      );
      if (job.state === "FAILED" || !job.result) {
        setImportMsg(t("common.fetchError", { error: job.error ?? "import failed" }));
        setTimeout(() => setImportMsg(null), 6000);
      } else {
        applyImportResult(job.result, job.state === "CANCELLED");
      }
    } catch (e) {
      setImportMsg(t("common.fetchError", { error: String(e) }));
      setTimeout(() => setImportMsg(null), 6000);
    } finally {
      setImportJob(null);
      setCancelling(false);
    }
  };

  /** 取り込みの結果を一覧に反映する（ファイル・フォルダ・ドロップ・URL で共通）。 */
  const applyImportResult = (r: ImportResult, cancelled = false) => {
    {
      const base =
        (cancelled ? t("main.import.cancelled") : "") +
        t("main.import.result", { imported: r.imported, skipped: r.skipped, failed: r.failed });
      // 検査日の無いスタディは既定の検索条件（今日）では出ない。取り込めているのに
      // 「失敗した」と読まれるため、件数があるときだけ理由と対処を添える。
      const view = importedStudiesView(r.studyInstanceUids);
      const withDateNote =
        !view && r.studiesWithoutDate > 0
          ? `${base} — ${t("main.import.noStudyDate", { count: r.studiesWithoutDate })}`
          : base;
      setImportMsg(withDateNote);
      if (view) {
        setAlbumView(null);
        setImportedView(view);
        setFilters(view.filters);
      }
      setReloadKey((k) => k + 1);
      // 注意文つきのときは読む時間が要る（既定の 6 秒では消えるのが早い）。
      setTimeout(() => setImportMsg(null), r.studiesWithoutDate > 0 ? 20000 : 6000);
    }
  };

  // 各ビューア起動。2D Viewer は別ウィンドウ（desktop）/ ハッシュ（web）で開く。3D/MPR/Slicer は順次。
  const handleOpenViewer = (kind: "2d" | "3d" | "mpr" | "slicer" | "qr" | "computejobs" | "assistant") => {
    if (kind === "assistant") {
      // AI アシスタントは常駐の別ウィンドウ（シングルトン）。患者・検査の文脈は渡さない。
      void desktop()?.openViewer?.("assistant");
      return;
    }
    if (kind === "computejobs") {
      // standalone のみ（メニュー側で出し分け）。別ウィンドウのシングルトン。
      void desktop()?.openViewer?.("computejobs");
      return;
    }
    if (kind === "qr") {
      // Query/Retrieve は常駐の別ウィンドウ。
      const d = desktop();
      if (d?.openViewer) void d.openViewer("qr");
      else window.open(`${window.location.pathname}#qr`, "graphy-qr");
      return;
    }
    if (kind === "2d") {
      // 選択中のスタディ/シリーズをコンテキストとして localStorage に書き込む。
      // Viewer2DScreen がマウント時または storage イベントで読み取る。
      if (selectedStudy) {
        const ctx = {
          study: selectedStudy,
          series: selectedSeries ?? undefined,
          ts: Date.now(),
        };
        localStorage.setItem("graphy-viewer-ctx", JSON.stringify(ctx));
      }
      const d = desktop();
      if (d?.openViewer) {
        void d.openViewer("2dviewer");
      } else {
        // named target でタブを再利用（既に開いていれば同タブにフォーカス）。
        window.open(`${window.location.pathname}#2dviewer`, "graphy-2dviewer");
      }
      return;
    }
    if (kind === "mpr") {
      // 選択中スタディ/シリーズを MPR ウィンドウへ受け渡す（2D と同方式の localStorage コンテキスト）。
      if (!selectedStudy) {
        window.alert(t("export.noSelection"));
        return;
      }
      const ctx = { study: selectedStudy, series: selectedSeries ?? undefined, ts: Date.now() };
      localStorage.setItem("graphy-mpr-ctx", JSON.stringify(ctx));
      const d = desktop();
      if (d?.openViewer) void d.openViewer("mpr");
      else window.open(`${window.location.pathname}#mpr`, "graphy-mpr");
      return;
    }
    if (kind === "3d") {
      // 選択中スタディ/シリーズを 3D Viewer ウィンドウへ受け渡す（MPR と同方式の localStorage コンテキスト）。
      if (!selectedStudy) {
        window.alert(t("export.noSelection"));
        return;
      }
      const ctx = { study: selectedStudy, series: selectedSeries ?? undefined, ts: Date.now() };
      localStorage.setItem("graphy-viewer3d-ctx", JSON.stringify(ctx));
      const d = desktop();
      if (d?.openViewer) void d.openViewer("viewer3d");
      else window.open(`${window.location.pathname}#viewer3d`, "graphy-viewer3d");
      return;
    }
    if (kind === "slicer") {
      // 選択中スタディ/シリーズを Slicer ウィンドウへ受け渡す（MPR と同方式の localStorage コンテキスト）。
      if (!selectedStudy) {
        window.alert(t("export.noSelection"));
        return;
      }
      const ctx = { study: selectedStudy, series: selectedSeries ?? undefined, ts: Date.now() };
      localStorage.setItem("graphy-slicer-ctx", JSON.stringify(ctx));
      const d = desktop();
      if (d?.openViewer) void d.openViewer("slicer");
      else window.open(`${window.location.pathname}#slicer`, "graphy-slicer");
      return;
    }
    const name = t(`main.toolbar.${kind === "3d" ? "viewer3d" : kind}`);
    setImportMsg(t("main.viewer.comingSoon", { name }));
    setTimeout(() => setImportMsg(null), 4000);
  };

  // データ I/O・ユーティリティ。実装済みはダイアログを開き、未実装は告知バナー（実装は fw に記録）。
  const handleOpenTool = (kind: ToolKind) => {
    if (kind === "tagExtractor") {
      setOpenTool("tagExtractor");
      return;
    }
    if (kind === "seriesExtractor") {
      setOpenTool("seriesExtractor");
      return;
    }
    if (kind === "anonymizer") {
      setOpenTool("anonymizer");
      return;
    }
    if (kind === "export") {
      if (!selectedStudy) {
        // MainScreen でスタディ未選択のときは患者を特定できないため、選択を促す。
        window.alert(t("export.noSelection"));
        return;
      }
      setOpenTool("export");
      return;
    }
    if (kind === "send") {
      if (!isStandalone) {
        // DICOM 送信（C-STORE）は standalone 専用（web にはローカル索引が無く送信対象を解決できない）。
        window.alert(t("common.standaloneOnlyFeature"));
        return;
      }
      if (!selectedStudy) {
        // 送信は患者特定が必要なため、スタディ選択を促す（Export と同じ）。
        window.alert(t("export.noSelection"));
        return;
      }
      setOpenTool("send");
      return;
    }
    if (kind === "tagViewer") {
      // 表示中の画像＝選択中シリーズ。未選択（画像非表示）ならポップアップで促す。
      if (!selectedSeries) {
        window.alert(t("tagview.noImage"));
        return;
      }
      setOpenTool("tagViewer");
      return;
    }
    if (kind === "report") {
      // レポートはスタディに紐づくため、患者/スタディ特定が必要（Export と同じ）。
      if (!selectedStudy) {
        window.alert(t("report.noSelection"));
        return;
      }
      setReportEditorId(null);
      setOpenTool("report");
      return;
    }
    if (kind === "reportManager") {
      if (!selectedStudy) {
        window.alert(t("report.noSelection"));
        return;
      }
      setOpenTool("reportManager");
      return;
    }
    if (kind === "dose") {
      // 線量レポートは検査単位（RDSR は検査に紐づく）。未選択なら促す。
      if (!selectedStudy) {
        window.alert(t("report.noSelection"));
        return;
      }
      setOpenTool("dose");
      return;
    }
    if (kind === "taskLauncher") {
      // 🔑 **スタディ未選択でも開く**。ここは「何ができるか」の一覧でもあるので、
      //    選択を促して閉じると未実装タスクの存在すら見えない（§21.2）。
      //    押せない理由はカードごとに出る。
      setOpenTool("taskLauncher");
      return;
    }
    if (kind === "urlImport") {
      if (!canImport) {
        window.alert(t("common.standaloneOnlyFeature"));
        return;
      }
      setOpenTool("urlImport");
      return;
    }
    if (kind === "nonDicomImport") {
      if (!isStandalone) {
        // 非DICOM取込はローカルファイルパス（Electron専用）が前提のため standalone 専用。
        window.alert(t("common.standaloneOnlyFeature"));
        return;
      }
      setOpenTool("nonDicomImport");
      return;
    }
    setImportMsg(t("main.viewer.comingSoon", { name: t(`main.toolbar.${kind}`) }));
    setTimeout(() => setImportMsg(null), 4000);
  };

  const dropHandlers = canImport
    ? {
        onDragEnter: (e: React.DragEvent) => {
          if (!hasDroppedFiles(e.dataTransfer?.types)) return;
          dragDepth.current += 1;
          setDropActive(true);
        },
        onDragOver: (e: React.DragEvent) => {
          if (!hasDroppedFiles(e.dataTransfer?.types)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = importingRef.current ? "none" : "copy";
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!hasDroppedFiles(e.dataTransfer?.types)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropActive(false);
        },
        onDrop: (e: React.DragEvent) => {
          if (!hasDroppedFiles(e.dataTransfer?.types)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDropActive(false);
          if (importingRef.current) return;
          const paths = droppedPaths(e.dataTransfer.files);
          if (paths.length === 0) {
            setImportMsg(t("main.import.dropNoPath"));
            setTimeout(() => setImportMsg(null), 6000);
            return;
          }
          void runImport(paths);
        },
      }
    : {};

  return (
    <div style={shell} {...dropHandlers} data-testid="main-screen">
      {dropActive && (
        <div style={dropOverlay} data-testid="main-drop-overlay">
          <div style={dropOverlayLabel}>{t("main.import.dropHint")}</div>
        </div>
      )}
      <MenuBar
        isStandalone={isStandalone}
        canImport={canImport}
        isDemo={isDemo}
        selectedStudyUid={selectedStudy?.studyInstanceUid ?? null}
        onImport={handleImport}
        onOpenTool={handleOpenTool}
        onOpenViewer={handleOpenViewer}
        onOpenSettings={onOpenSettings}
        onOpenDb={onOpenDb}
        onOpenHelp={onOpenHelp}
        onOpenMobileUi={onOpenMobileUi}
      />
      <Toolbar
        isStandalone={isStandalone}
        canImport={canImport}
        isDemo={isDemo}
        onImport={handleImport}
        onRefresh={() => setReloadKey((k) => k + 1)}
        onOpenDb={onOpenDb}
        onOpenTool={handleOpenTool}
        onOpenViewer={handleOpenViewer}
        onOpenSettings={onOpenSettings}
        onOpenHelp={onOpenHelp}
      />
      {importJob && (
        <ImportProgressBanner
          status={importJob}
          cancelling={cancelling}
          onCancel={() => {
            cancelRequested.current = true;
            setCancelling(true);
          }}
        />
      )}
      {importMsg && <div style={banner}>{importMsg}</div>}
      <div style={middle}>
        {/* status（isDemo）は非同期取得のため、確定後に isDemo が変わったら SearchPanel を
            再マウントして初期日付(1900/01/01〜当日)を再計算させる。 */}
        <SearchPanel key={String(isDemo)} onSearch={onSearch} isDemo={isDemo} missingSupported={status?.mode !== "web"} />
        <div style={centerColumn}>
        <div style={listArea(listLayout)}>
        <div style={treeArea}>
          <AlbumBar view={albumView} version={albumVersion} onOpen={openAlbum} onClose={closeAlbum} onChanged={onAlbumChanged} batchEnabled={isStandalone} />
          {importedView && (
            <div style={importedBanner} data-testid="imported-view-banner">
              <span>
                {importedView.shown < importedView.total
                  ? t("main.import.showingImportedPartial", { shown: importedView.shown, total: importedView.total })
                  : t("main.import.showingImported", { count: importedView.total })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setImportedView(null);
                  setFilters(searchFiltersRef.current);
                }}
              >
                {t("main.import.backToSearch")}
              </button>
            </div>
          )}
          <StudyList
            filters={filters}
            reloadKey={reloadKey + dbVersion}
            connecting={!status}
            mode={isStandalone ? "standalone" : "web"}
            onSelectStudy={(s) => { setSelectedStudy(s); setSelectedSeries(null); }}
            onSelectSeries={setSelectedSeries}
            previewHost={dockHost}
            layout={listLayout}
            onLayoutChange={changeListLayout}
            seriesHost={isPaneLayout(listLayout) ? seriesPane : undefined}
            albumView={albumView}
            albumVersion={albumVersion}
            onAlbumChanged={onAlbumChanged}
          />
        </div>
        {isPaneLayout(listLayout) && (
          <div ref={setSeriesPane} data-testid="series-pane" style={seriesPaneStyle(listLayout)}>
            {!selectedStudy && <div style={{ padding: "8px 18px", fontSize: 13, color: "#888" }}>{t("main.layout.pickStudy")}</div>}
          </div>
        )}
        </div>
        <PreviewDock onHost={setDockHost} />
        </div>
      </div>
      <StatusBar
        status={status}
        error={error}
        importWatch={importWatch.view}
        receiveAnon={receiveAnon}
        computeJobs={computeJobsStatus.counts}
        keepAwake={computeJobsStatus.keepAwake}
        onOpenComputeJobs={() => handleOpenViewer("computejobs")}
        onReloadList={() => {
          setReloadKey((k) => k + 1);
          importWatch.acknowledge();
        }}
      />
      <TagExtractorDialog
        open={openTool === "tagExtractor"}
        onClose={() => setOpenTool(null)}
        filters={filters}
      />
      <SeriesExtractorDialog
        open={openTool === "seriesExtractor"}
        onClose={() => setOpenTool(null)}
        filters={filters}
        mode={isStandalone ? "standalone" : "web"}
      />
      <AnonymizerDialog
        open={openTool === "anonymizer"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
        filters={filters}
        mode={isStandalone ? "standalone" : "web"}
      />
      <ExportDialog open={openTool === "export"} onClose={() => setOpenTool(null)} study={selectedStudy} />
      <SendDialog open={openTool === "send"} onClose={() => setOpenTool(null)} study={selectedStudy} />
      <TagViewerDialog
        open={openTool === "tagViewer"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
        series={selectedSeries}
        editable={isStandalone}
      />
      <NonDicomImportDialog
        open={openTool === "nonDicomImport"}
        onClose={() => {
          setOpenTool(null);
          if (urlFile) void deleteUrlImportFile(urlFile.jobId).catch(() => undefined);
          setUrlFile(null);
        }}
        study={selectedStudy}
        initialPaths={urlFile ? [urlFile.path] : undefined}
        onImported={() => setReloadKey((k) => k + 1)}
      />
      <UrlImportDialog
        open={openTool === "urlImport"}
        onClose={() => setOpenTool(null)}
        onDicomImported={(r) => applyImportResult(r)}
        onFile={(path, jobId) => {
          setUrlFile({ path, jobId });
          setOpenTool("nonDicomImport");
        }}
      />
      <ReportEditorDialog
        open={openTool === "report"}
        onClose={() => { setOpenTool(null); setReportEditorId(null); }}
        study={selectedStudy}
        series={selectedSeries}
        mode={isStandalone ? "standalone" : "web"}
        reportId={reportEditorId}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
      <DoseReportDialog
        open={openTool === "dose"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
      />
      <TaskLauncherDialog
        open={openTool === "taskLauncher"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
        series={selectedSeries}
        isStandalone={isStandalone}
        onOpenReport={() => handleOpenTool("report")}
      />
      <ReportManagerDialog
        open={openTool === "reportManager"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
        onOpenReport={(id) => { setReportEditorId(id); setOpenTool("report"); }}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
    </div>
  );
}

const shell: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
  background: "#fff",
};
const middle: React.CSSProperties = { flex: 1, display: "flex", minHeight: 0 };
// 一覧（スクロール）と、その下に固定するプレビューのドックを縦に並べる列。
const centerColumn: React.CSSProperties = { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 };
const treeArea: React.CSSProperties = { flex: 1, overflow: "auto", padding: "8px 18px" };
// 検査の表とシリーズのペインを並べる領域。上下は縦、左右は横。
const listArea = (l: ListLayout): React.CSSProperties => ({
  flex: 1, display: "flex", flexDirection: l === "side" ? "row" : "column", minWidth: 0, minHeight: 0,
});
// シリーズのペイン。上下: 検査の表の下に固定し、中身に合わせた高さで最大 35%（超えたら中でスクロール）。
// 左右: 検査の表の右に、幅 40%・縦スクロール。
const seriesPaneStyle = (l: ListLayout): React.CSSProperties =>
  l === "side"
    ? { flex: "0 0 40%", minWidth: 0, overflow: "auto", borderLeft: "1px solid #cdd5de" }
    : { flex: "none", maxHeight: "35%", overflow: "auto", borderTop: "1px solid #cdd5de" };
const dropOverlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(30, 90, 160, 0.12)",
  border: "3px dashed #1e5aa0",
  pointerEvents: "none",
};

const dropOverlayLabel: React.CSSProperties = {
  padding: "12px 20px",
  borderRadius: 8,
  background: "#1e5aa0",
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
};

const banner: React.CSSProperties = {
  padding: "6px 14px",
  background: "#eef6ec",
  borderBottom: "1px solid #d6e6d0",
  fontSize: 13,
  color: "#2e5d27",
};

const importedBanner: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 10px",
  marginBottom: 8,
  background: "#eaf2fb",
  border: "1px solid #c9dcf0",
  borderRadius: 4,
  fontSize: 13,
  color: "#1a4a80",
};
