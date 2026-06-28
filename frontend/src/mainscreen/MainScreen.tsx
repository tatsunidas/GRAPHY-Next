import { useState } from "react";
import { type AppStatus, type StudyFilters } from "../api";
import { StudyList } from "../StudyList";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { SearchPanel } from "./SearchPanel";
import { StatusBar } from "./StatusBar";

/**
 * アプリの土台シェル（GRAPHY の MainScreen 相当）。
 * メニュー / ツールバー / 検索パネル / STUDY ツリーテーブル / 状態・時刻表示。
 * web 版はこのままポータル画面として使う（検索→スタディ一覧→ビューア起動）。
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
  const isStandalone = status?.mode === "standalone";
  const [filters, setFilters] = useState<StudyFilters>({});
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div style={shell}>
      <MenuBar
        isStandalone={isStandalone}
        onOpenSettings={onOpenSettings}
        onOpenDb={onOpenDb}
        onOpenHelp={onOpenHelp}
      />
      <Toolbar
        isStandalone={isStandalone}
        onRefresh={() => setReloadKey((k) => k + 1)}
        onOpenDb={onOpenDb}
        onOpenSettings={onOpenSettings}
        onOpenHelp={onOpenHelp}
      />
      <div style={middle}>
        <SearchPanel onSearch={setFilters} />
        <div style={treeArea}>
          <StudyList filters={filters} reloadKey={reloadKey} />
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
