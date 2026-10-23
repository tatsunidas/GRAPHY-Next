/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シリーズ選択の窓（`host.db.pickSeries`）。保管庫の検査を検索・絞り込みし、スタディを展開してシリーズにチェックを入れる。
 * 患者名・検査日・記述は利用者のために出すだけで、プラグインへ返すのは選んだ UID だけ（{@link toResult}）。
 *
 * <p>シリーズの取得はスタディごとの GET なので、**展開したとき・スタディのチェックを押したときにだけ**取る（N+1 を避ける）。
 * `window.confirm` は使わない（Electron のネイティブダイアログがキーボードフォーカスを奪うため。`AiEgressConsentDialog` と同じ）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchSeries, fetchStudies, type Series, type Study, type StudyFilters } from "../api";
import { useI18n } from "../i18n/i18n";
import { MODALITY_OPTIONS } from "../mainscreen/SearchPanel";
import { TriCheckbox } from "../mainscreen/TriCheckbox";
import { imageCount } from "../imageCount";
import { isEligible, pickKey, studyState, toResult, toggleSeries, toggleStudy, type PickedSeries } from "./seriesPickLogic";

const SEARCH_DEBOUNCE_MS = 250;

/** "YYYYMMDD" → "YYYY-MM-DD"（表示用）。形が違えばそのまま。 */
const showDate = (v: string | null): string => (v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v ?? "");
const fromInputDate = (v: string) => v.replace(/-/g, "");

export function SeriesPickDialog({
  title,
  modalities,
  multiple,
  onDone,
  onCancel,
}: {
  title: string;
  /** 選べるシリーズの種類（空なら制限なし）。 */
  modalities: string[];
  multiple: boolean;
  onDone: (r: PickedSeries[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [pid, setPid] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // 絞り込みの種類。制限があるときは制限の範囲から選ぶ（初期は制限の全部）
  const candidates = modalities.length > 0 ? modalities : MODALITY_OPTIONS;
  const [filterMods, setFilterMods] = useState<string[]>(modalities);
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seriesMap, setSeriesMap] = useState<Record<string, Series[] | "loading" | "error">>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const loading = useRef<Map<string, Promise<Series[]>>>(new Map());

  const filters: StudyFilters = useMemo(() => {
    const f: StudyFilters = {};
    if (pid.trim()) f.patientId = pid.trim();
    if (name.trim()) f.patientName = name.trim();
    if (from) f.studyDateFrom = fromInputDate(from);
    if (to) f.studyDateTo = fromInputDate(to);
    // 制限があるときは、絞り込みが空でも制限の種類で引く（他の種類のスタディを出さない）
    const mods = filterMods.length > 0 ? filterMods : modalities;
    if (mods.length) f.modality = mods.join(",");
    return f;
  }, [pid, name, from, to, filterMods, modalities]);
  const filterKey = JSON.stringify(filters);

  // 検索（入力のたびに少し待ってから引く。古い応答は捨てる）
  useEffect(() => {
    const id = setTimeout(() => {
      const mine = ++seq.current;
      setStudies(null);
      setError(null);
      fetchStudies(filters)
        .then((r) => {
          if (mine === seq.current) setStudies(r);
        })
        .catch((e: unknown) => {
          if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // Esc で取り消す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /** スタディのシリーズを取る（取ってあれば使い回す）。 */
  const loadSeries = useCallback((uid: string): Promise<Series[]> => {
    const hit = loading.current.get(uid);
    if (hit) return hit;
    setSeriesMap((m) => ({ ...m, [uid]: "loading" }));
    const p = fetchSeries(uid)
      .then((s) => {
        setSeriesMap((m) => ({ ...m, [uid]: s }));
        return s;
      })
      .catch(() => {
        loading.current.delete(uid);
        setSeriesMap((m) => ({ ...m, [uid]: "error" }));
        return [] as Series[];
      });
    loading.current.set(uid, p);
    return p;
  }, []);

  const toggleExpand = (uid: string) => {
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
    void loadSeries(uid);
  };

  const onStudyCheck = async (uid: string) => {
    const s = await loadSeries(uid);
    setSelected((cur) => toggleStudy(uid, s, cur, modalities, multiple));
  };

  const toggleMod = (m: string) => setFilterMods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));

  const confirm = () => onDone(toResult(selected));

  return createPortal(
    <div style={backdrop} data-testid="pickseries-dialog">
      <div style={panel} role="dialog" aria-modal="true">
        <div style={titleStyle} data-testid="pickseries-title">
          {title || t("pickSeries.title")}
        </div>

        <div style={filterBar}>
          <input data-testid="pickseries-filter-name" placeholder={t("pickSeries.filter.name")} value={name} onChange={(e) => setName(e.target.value)} style={input} />
          <input data-testid="pickseries-filter-id" placeholder={t("pickSeries.filter.id")} value={pid} onChange={(e) => setPid(e.target.value)} style={input} />
          <label style={dateLabel}>
            {t("pickSeries.filter.from")}
            <input data-testid="pickseries-filter-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label style={dateLabel}>
            {t("pickSeries.filter.to")}
            <input data-testid="pickseries-filter-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <div style={chipBar}>
          <span style={{ color: "#667" }}>{t("pickSeries.filter.modality")}</span>
          {candidates.map((m) => (
            <button
              key={m}
              data-testid={`pickseries-modality-${m}`}
              aria-pressed={filterMods.includes(m)}
              onClick={() => toggleMod(m)}
              style={{ ...chip, ...(filterMods.includes(m) ? chipOn : {}) }}
            >
              {m}
            </button>
          ))}
          {modalities.length > 0 && <span style={{ color: "#8a5a00" }}>{t("pickSeries.limited", { list: modalities.join("・") })}</span>}
        </div>

        <div style={list} data-testid="pickseries-list">
          {studies === null && !error && <div style={note} data-testid="pickseries-loading">{t("pickSeries.loading")}</div>}
          {error && <div style={{ ...note, color: "#b00020" }} data-testid="pickseries-error">{t("pickSeries.error", { message: error })}</div>}
          {studies?.length === 0 && <div style={note} data-testid="pickseries-empty">{t("pickSeries.empty")}</div>}
          {studies?.map((st) => {
            const uid = st.studyInstanceUid;
            const sv = seriesMap[uid];
            const loaded = Array.isArray(sv) ? sv : null;
            const open = expanded.has(uid);
            return (
              <div key={uid} data-testid={`pickseries-study-${uid}`} style={{ borderBottom: "1px solid #eef1f4" }}>
                <div style={studyRow}>
                  <TriCheckbox
                    state={loaded ? studyState(uid, loaded, selected, modalities) : "none"}
                    onChange={() => void onStudyCheck(uid)}
                    testId={`pickseries-study-check-${uid}`}
                  />
                  <button data-testid={`pickseries-expand-${uid}`} onClick={() => toggleExpand(uid)} style={expandBtn} aria-expanded={open}>
                    {open ? "▾" : "▸"}
                  </button>
                  <span style={{ fontWeight: 600, minWidth: 160 }}>{st.patientName ?? t("pickSeries.unnamed")}</span>
                  <span style={{ minWidth: 90 }}>{showDate(st.studyDate)}</span>
                  <span style={{ flex: 1, color: "#445" }}>{st.studyDescription ?? ""}</span>
                  <span style={{ color: "#667" }}>{(st.modalities ?? (st.modality ? [st.modality] : [])).join("/")}</span>
                  <span style={{ color: "#667", minWidth: 70, textAlign: "right" }}>{t("pickSeries.images", { n: imageCount(st) })}</span>
                </div>
                {open && (
                  <div style={{ paddingLeft: 52, paddingBottom: 6 }}>
                    {sv === "loading" && <div style={note}>{t("pickSeries.loading")}</div>}
                    {sv === "error" && <div style={{ ...note, color: "#b00020" }}>{t("pickSeries.seriesError")}</div>}
                    {loaded?.map((s) => {
                      const ok = isEligible(s, modalities);
                      const k = pickKey(uid, s.seriesInstanceUid);
                      return (
                        <label key={s.seriesInstanceUid} data-testid={`pickseries-series-${s.seriesInstanceUid}`} style={{ ...seriesRow, opacity: ok ? 1 : 0.45 }}>
                          <input
                            type="checkbox"
                            data-testid={`pickseries-series-check-${s.seriesInstanceUid}`}
                            checked={selected.has(k)}
                            disabled={!ok}
                            onChange={() => setSelected((cur) => toggleSeries(uid, s, cur, modalities, multiple))}
                          />
                          <span style={{ minWidth: 36 }}>#{s.seriesNumber ?? "–"}</span>
                          <span style={{ minWidth: 40 }}>{s.modality ?? "?"}</span>
                          <span style={{ flex: 1 }}>{s.seriesDescription ?? ""}</span>
                          <span style={{ color: "#667" }}>{t("pickSeries.images", { n: imageCount(s) })}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={footer}>
          <span data-testid="pickseries-count" style={{ flex: 1 }}>
            {t("pickSeries.count", { n: selected.size })}
          </span>
          <button data-testid="pickseries-clear" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
            {t("pickSeries.clear")}
          </button>
          <button data-testid="pickseries-cancel" onClick={onCancel}>
            {t("pickSeries.cancel")}
          </button>
          <button data-testid="pickseries-ok" className="primary" disabled={selected.size === 0} onClick={confirm} style={okBtn}>
            {t("pickSeries.ok", { n: selected.size })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 };
const panel: React.CSSProperties = { width: 880, maxWidth: "96vw", height: 640, maxHeight: "92vh", background: "#fff", borderRadius: 8, display: "flex", flexDirection: "column", fontSize: 13, color: "#222", boxShadow: "0 10px 40px rgba(0,0,0,0.3)" };
const titleStyle: React.CSSProperties = { fontSize: 15, fontWeight: 600, padding: "12px 16px", borderBottom: "1px solid #e6eaee" };
const filterBar: React.CSSProperties = { display: "flex", gap: 8, padding: "8px 16px 0", flexWrap: "wrap", alignItems: "center" };
const chipBar: React.CSSProperties = { display: "flex", gap: 6, padding: "8px 16px", flexWrap: "wrap", alignItems: "center" };
const input: React.CSSProperties = { padding: "3px 8px", border: "1px solid #c8d0d8", borderRadius: 4, width: 150 };
const dateLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, color: "#667" };
const chip: React.CSSProperties = { border: "1px solid #c8d0d8", borderRadius: 10, padding: "1px 10px", background: "#fff", cursor: "pointer" };
const chipOn: React.CSSProperties = { background: "#e8f1fb", borderColor: "#7fb0e0", color: "#0b5cad" };
const list: React.CSSProperties = { flex: 1, overflow: "auto", borderTop: "1px solid #e6eaee", borderBottom: "1px solid #e6eaee" };
const note: React.CSSProperties = { padding: "10px 16px", color: "#667" };
const studyRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "5px 16px" };
const expandBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 14, width: 20 };
const seriesRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "2px 8px" };
const footer: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px" };
const okBtn: React.CSSProperties = { background: "#0b5cad", color: "#fff", border: "1px solid #0b5cad", borderRadius: 4, padding: "4px 16px" };
