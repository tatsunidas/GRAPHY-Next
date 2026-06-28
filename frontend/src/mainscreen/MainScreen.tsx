import { useState } from "react";
import { importPaths, type AppStatus, type StudyFilters } from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { StudyList } from "../StudyList";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { SearchPanel } from "./SearchPanel";
import { StatusBar } from "./StatusBar";

/**
 * アプリの土台シェル（GRAPHY の MainScreen 相当）。
 * メニュー / ツールバー / 検索パネル / STUDY ツリーテーブル / 状態・時刻表示。
 * web 版はそのままポータル画面として使う（検索→スタディ一覧→ビューア起動）。
 */
export function MainScreen({
  status,
  error,
  onOpenSettings,
  onOpenDb,
  onOpenHelp,
}: {
  status: AppStatus | null;
  error: string | null;
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

  // 各ビューア起動。2D/3D/MPR/Slicer 画面は順次実装予定。今は告知バナーを出す。
  const handleOpenViewer = (kind: "2d" | "3d" | "mpr" | "slicer") => {
    const name = t(`main.toolbar.${kind === "2d" ? "viewer2d" : kind === "3d" ? "viewer3d" : kind}`);
    setImportMsg(t("main.viewer.comingSoon", { name }));
    setTimeout(() => setImportMsg(null), 4000);
  };

  return (
    <div style={shell}>
      <MenuBar
        isStandalone={isStandalone}
        canImport={canImport}
        onImport={handleImport}
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
        onOpenViewer={handleOpenViewer}
        onOpenSettings={onOpenSettings}
        onOpenHelp={onOpenHelp}
      />
      {importMsg && <div style={banner}>{importMsg}</div>}
      <div style={middle}>
        <SearchPanel onSearch={setFilters} />
        <div style={treeArea}>
          <StudyList filters={filters} reloadKey={reloadKey} mode={isStandalone ? "standalone" : "web"} />
        </div>
      </div>
      <StatusBar status={status} error={error} />
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
