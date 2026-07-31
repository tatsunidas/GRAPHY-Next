/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイルシェルの「検索 → スタディ一覧」「シリーズ一覧」（`fw/mobile-ui-design.md` M2）。
 *
 * <p>デスクトップの表（`StudyList.tsx`）は列が 6〜7 本あり狭幅では成立しないので、
 * **1 件 = 1 カード**の縦リストにする。取得は `hooks/useStudies` / `useSeries` を共有し、
 * 表示だけを作り直す（§3.5 でフックに切り出した目的そのもの）。
 */
import { useMemo, useState } from "react";
import type { Series, Study, StudyFilters } from "../api";
import { useSeries } from "../hooks/useSeries";
import { useStudies } from "../hooks/useStudies";
import { useI18n } from "../i18n/i18n";
import { DATE_RANGE_KEYS, DATE_RANGE_LABEL_KEY, dateRangeFilter, type DateRangeKey } from "./dateRange";

/** 検索フォーム ＋ スタディ一覧。 */
export function MobileStudyList({
  filters,
  onSearch,
  onSelect,
}: {
  filters: StudyFilters | null;
  onSearch: (f: StudyFilters) => void;
  onSelect: (s: Study) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRangeKey>("month");
  const { studies, error, loading } = useStudies(filters);

  const submit = (nextRange: DateRangeKey = range) => {
    const { from, to } = dateRangeFilter(nextRange, new Date());
    const f: StudyFilters = { studyDateFrom: from, studyDateTo: to };
    const q = query.trim();
    // 1 本の入力欄で ID と氏名の両方を賄うのは狭幅ゆえの割り切り。
    // 数字だけなら患者 ID、それ以外は氏名として扱う（backend はどちらも部分一致）。
    if (q) {
      if (/^[0-9]+$/.test(q)) f.patientId = q;
      else f.patientName = q;
    }
    onSearch(f);
  };

  return (
    <div style={col}>
      <form
        style={searchBox}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          style={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("mobile.search.placeholder")}
          // 検索欄なので iOS のキーボードを「検索」にする。
          type="search"
          enterKeyHint="search"
          data-testid="mobile-search-input"
        />
        <div style={chipRow}>
          {DATE_RANGE_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              style={k === range ? chipOn : chip}
              onClick={() => {
                setRange(k);
                submit(k); // 期間を選んだら即検索（ボタンを 2 回押させない）
              }}
            >
              {t(DATE_RANGE_LABEL_KEY[k])}
            </button>
          ))}
        </div>
        <button type="submit" style={primaryBtn} data-testid="mobile-search-submit">
          {t("common.search")}
        </button>
      </form>

      {error && <p style={errorText}>{t("common.fetchError", { error })}</p>}
      {loading && <p style={hintText}>{t("common.loading")}</p>}
      {!loading && filters == null && <p style={hintText}>{t("study.prompt")}</p>}
      {!loading && studies && studies.length === 0 && <p style={hintText}>{t("common.noData")}</p>}

      {studies?.map((s) => (
        <button
          key={s.studyInstanceUid}
          style={card}
          onClick={() => onSelect(s)}
          data-testid={`mobile-study-${s.studyInstanceUid}`}
        >
          <span style={cardTitle}>{s.patientName || s.patientId || s.studyInstanceUid}</span>
          <span style={cardMeta}>
            {[formatStudyDate(s.studyDate), s.modality, s.patientId].filter(Boolean).join(" · ")}
          </span>
          <span style={cardSub}>{s.studyDescription || "—"}</span>
          <span style={cardMeta}>{t("study.list.total", { n: s.numberOfInstances })}</span>
        </button>
      ))}
    </div>
  );
}

/** 選択スタディのシリーズ一覧。 */
export function MobileSeriesList({ study, onSelect }: { study: Study; onSelect: (s: Series) => void }) {
  const { t } = useI18n();
  const { series, error, loading } = useSeries(study.studyInstanceUid);

  const sorted = useMemo(
    () => (series ? [...series].sort((a, b) => (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0)) : null),
    [series],
  );

  return (
    <div style={col}>
      <p style={hintText}>{study.patientName || study.patientId || study.studyInstanceUid}</p>
      {error && <p style={errorText}>{t("common.fetchError", { error })}</p>}
      {loading && <p style={hintText}>{t("common.loading")}</p>}
      {!loading && sorted && sorted.length === 0 && <p style={hintText}>{t("series.empty")}</p>}

      {sorted?.map((se) => (
        <button
          key={se.seriesInstanceUid}
          style={card}
          onClick={() => onSelect(se)}
          data-testid={`mobile-series-${se.seriesInstanceUid}`}
        >
          <span style={cardTitle}>{se.seriesDescription || `#${se.seriesNumber ?? "—"}`}</span>
          <span style={cardMeta}>
            {[se.seriesNumber != null ? `#${se.seriesNumber}` : null, se.modality].filter(Boolean).join(" · ")}
          </span>
          <span style={cardMeta}>{t("field.instanceCount")}: {se.numberOfInstances}</span>
        </button>
      ))}
    </div>
  );
}

/** DICOM `YYYYMMDD` を `YYYY-MM-DD` にする（それ以外の形式はそのまま返す）。 */
function formatStudyDate(v: string | null): string {
  if (!v) return "";
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}

// ── スタイル ──

const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10 };

const searchBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  border: "1px solid #262c35",
  borderRadius: 10,
  background: "#171b22",
};

const input: React.CSSProperties = {
  minHeight: 44,
  padding: "0 12px",
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "#0e1218",
  color: "#e8ecf1",
  // ⚠️ iOS Safari は 16px 未満の入力欄でフォーカス時に自動ズームする。16px 以上を維持すること。
  fontSize: 16,
};

const chipRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };

const chip: React.CSSProperties = {
  minHeight: 36,
  padding: "0 12px",
  border: "1px solid #39414d",
  borderRadius: 18,
  background: "transparent",
  color: "#9fb2c9",
  fontSize: 13,
  cursor: "pointer",
};

const chipOn: React.CSSProperties = { ...chip, background: "#0b5cad", borderColor: "#2f6db5", color: "#fff" };

const primaryBtn: React.CSSProperties = {
  minHeight: 44,
  border: "1px solid #2f6db5",
  borderRadius: 8,
  background: "#0b5cad",
  color: "#fff",
  fontSize: 15,
  cursor: "pointer",
};

const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 4,
  width: "100%",
  minHeight: 44,
  padding: "12px 14px",
  border: "1px solid #262c35",
  borderRadius: 10,
  background: "#171b22",
  color: "#e8ecf1",
  textAlign: "left",
  cursor: "pointer",
};

const cardTitle: React.CSSProperties = { fontSize: 15, fontWeight: 600 };
const cardSub: React.CSSProperties = { fontSize: 13, color: "#c3cddb" };
const cardMeta: React.CSSProperties = { fontSize: 12, color: "#8b9bb0" };
const hintText: React.CSSProperties = { margin: 0, fontSize: 13, color: "#8b9bb0" };
const errorText: React.CSSProperties = { margin: 0, fontSize: 13, color: "#ff8a8a" };
