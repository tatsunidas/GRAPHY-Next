/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { fetchStudies, type StudyFilters } from "../api";
import { useI18n } from "../i18n/i18n";
import { SeriesExtractorPanel } from "./SeriesExtractorPanel";
import type { ScopeSpec } from "./seriesScopeUtil";

/**
 * シリーズ抽出（メイン画面の検索リストが対象）。本体は {@link SeriesExtractorPanel}。
 * DB テーブル管理の「シリーズ抽出」タブ（DB 全体が対象）と同じ画面を、検索リストに対して開く入口。
 */
export function SeriesExtractorDialog({
  open,
  onClose,
  filters,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  filters: StudyFilters | null;
  mode: string;
}) {
  const { t } = useI18n();
  if (!open) return null;

  const resolveScope = async (): Promise<ScopeSpec> => {
    if (!filters) throw new Error(t("tagext.err.noSearch"));
    const studies = await fetchStudies(filters);
    if (studies.length === 0) throw new Error(t("tagext.err.noStudies"));
    return { studyUids: studies.map((s) => s.studyInstanceUid) };
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div data-testid="series-extractor-dialog" style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("seriesext.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: "10px 14px" }}>
          <SeriesExtractorPanel
            active={open}
            scopeSlot={<div style={scopeBar}>{t("seriesext.scope.searchList")}</div>}
            scopeKey={JSON.stringify(filters)}
            resolveScope={resolveScope}
            mode={mode}
          />
        </div>
      </div>
    </div>
  );
}

const scopeBar: React.CSSProperties = { fontSize: 12, color: "#556", background: "#f3f6f9", border: "1px solid #e1e7ee", borderRadius: 6, padding: "5px 10px" };
const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const dialog: React.CSSProperties = { width: 1080, maxWidth: "97vw", height: 800, maxHeight: "95vh", background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
