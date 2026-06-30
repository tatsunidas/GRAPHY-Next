/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useState } from "react";
import { importPaths, type AppStatus, type Study, type Series, type StudyFilters } from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { StudyList } from "../StudyList";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { SearchPanel } from "./SearchPanel";
import { StatusBar } from "./StatusBar";
import { TagExtractorDialog } from "./TagExtractorDialog";
import { ExportDialog } from "./ExportDialog";
import { TagViewerDialog } from "./TagViewerDialog";
import { NonDicomImportDialog } from "./NonDicomImportDialog";

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
}: {
  status: AppStatus | null;
  error: string | null;
  /** DB 管理での編集成功時にインクリメントされ、スタディ一覧を再読込する。 */
  dbVersion?: number;
  onOpenSettings: () => void;
  onOpenDb: () => void;
  onOpenHelp: () => void;
}) {
  const { t } = useI18n();
  const isStandalone = status?.mode === "standalone";
  const canImport = isStandalone && !!desktop();
  // null = まだ検索していない。SearchPanel が初期条件(今日)で onSearch を呼ぶと埋まる。
  const [filters, setFilters] = useState<StudyFilters | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [selectedStudy, setSelectedStudy] = useState<Study | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [openTool, setOpenTool] = useState<
    "tagExtractor" | "export" | "tagViewer" | "nonDicomImport" | null
  >(null);

  const handleImport = async () => {
    const d = desktop();
    if (!d) return;
    const paths = await d.pickImportPaths();
    if (!paths || paths.length === 0) return;
    setImportMsg(t("main.import.running"));
    try {
      const r = await importPaths(paths);
      setImportMsg(t("main.import.result", { imported: r.imported, skipped: r.skipped, failed: r.failed }));
      setReloadKey((k) => k + 1);
    } catch (e) {
      setImportMsg(t("common.fetchError", { error: String(e) }));
    }
    setTimeout(() => setImportMsg(null), 6000);
  };

  // 各ビューア起動。2D Viewer は別ウィンドウ（desktop）/ ハッシュ（web）で開く。3D/MPR/Slicer は順次。
  const handleOpenViewer = (kind: "2d" | "3d" | "mpr" | "slicer") => {
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
    const name = t(`main.toolbar.${kind === "3d" ? "viewer3d" : kind}`);
    setImportMsg(t("main.viewer.comingSoon", { name }));
    setTimeout(() => setImportMsg(null), 4000);
  };

  // データ I/O・ユーティリティ。実装済みはダイアログを開き、未実装は告知バナー（実装は fw に記録）。
  const handleOpenTool = (
    kind: "export" | "nonDicomImport" | "anonymizer" | "tagExtractor" | "seriesExtractor" | "tagViewer",
  ) => {
    if (kind === "tagExtractor") {
      setOpenTool("tagExtractor");
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
    if (kind === "tagViewer") {
      // 表示中の画像＝選択中シリーズ。未選択（画像非表示）ならポップアップで促す。
      if (!selectedSeries) {
        window.alert(t("tagview.noImage"));
        return;
      }
      setOpenTool("tagViewer");
      return;
    }
    if (kind === "nonDicomImport") {
      setOpenTool("nonDicomImport");
      return;
    }
    setImportMsg(t("main.viewer.comingSoon", { name: t(`main.toolbar.${kind}`) }));
    setTimeout(() => setImportMsg(null), 4000);
  };

  return (
    <div style={shell}>
      <MenuBar
        isStandalone={isStandalone}
        canImport={canImport}
        onImport={handleImport}
        onOpenTool={handleOpenTool}
        onOpenViewer={handleOpenViewer}
        onOpenSettings={onOpenSettings}
        onOpenDb={onOpenDb}
        onOpenHelp={onOpenHelp}
      />
      <Toolbar
        isStandalone={isStandalone}
        canImport={canImport}
        onImport={handleImport}
        onRefresh={() => setReloadKey((k) => k + 1)}
        onOpenDb={onOpenDb}
        onOpenTool={handleOpenTool}
        onOpenViewer={handleOpenViewer}
        onOpenSettings={onOpenSettings}
        onOpenHelp={onOpenHelp}
      />
      {importMsg && <div style={banner}>{importMsg}</div>}
      <div style={middle}>
        <SearchPanel onSearch={setFilters} />
        <div style={treeArea}>
          <StudyList
            filters={filters}
            reloadKey={reloadKey + dbVersion}
            mode={isStandalone ? "standalone" : "web"}
            onSelectStudy={(s) => { setSelectedStudy(s); setSelectedSeries(null); }}
            onSelectSeries={setSelectedSeries}
          />
        </div>
      </div>
      <StatusBar status={status} error={error} />
      <TagExtractorDialog
        open={openTool === "tagExtractor"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
        series={selectedSeries}
      />
      <ExportDialog open={openTool === "export"} onClose={() => setOpenTool(null)} study={selectedStudy} />
      <TagViewerDialog
        open={openTool === "tagViewer"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
        series={selectedSeries}
      />
      <NonDicomImportDialog
        open={openTool === "nonDicomImport"}
        onClose={() => setOpenTool(null)}
        study={selectedStudy}
        onImported={() => setReloadKey((k) => k + 1)}
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
const treeArea: React.CSSProperties = { flex: 1, overflow: "auto", padding: "8px 18px" };
const banner: React.CSSProperties = {
  padding: "6px 14px",
  background: "#eef6ec",
  borderBottom: "1px solid #d6e6d0",
  fontSize: 13,
  color: "#2e5d27",
};
