/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchStudies, seriesExtractScope, type SeriesScopeCounts, type Study, type StudyFilters } from "../api";
import { useI18n } from "../i18n/i18n";
import { subscribeDbChanged } from "../dbEvents";
import { TriCheckbox } from "../mainscreen/TriCheckbox";
import {
  LIST_CAP,
  buildScope,
  cleanFilters,
  groupByPatient,
  isLargeScope,
  patientState,
  togglePatient,
  toggleStudy,
  type ScopeSpec,
} from "../mainscreen/seriesScopeUtil";

/** <input type=date> の "YYYY-MM-DD" ⇄ DICOM の "YYYYMMDD"。 */
const toDa = (v: string) => v.replace(/-/g, "");
const fromDa = (v: string | undefined) => (v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : "");

/**
 * DB 管理の「シリーズ抽出」タブの対象指定。患者・期間・モダリティで絞り、規模（スタディ/シリーズ/枚数）を
 * 実行前に見せる。個別に外したいときだけスタディの一覧を開く（大規模 DB では一覧は出さず、条件全体を対象にする）。
 * 何も外していなければ条件のまま（サーバーで解決）送るので、大きな UID 一覧を画面が運ばない。
 */
export function DbScopePicker({ onChange, active }: { onChange: (scope: ScopeSpec, key: string) => void; active: boolean }) {
  const { t } = useI18n();
  const [f, setF] = useState<StudyFilters>({});
  const filters = useMemo(() => cleanFilters(f), [f]);

  const [counts, setCounts] = useState<SeriesScopeCounts | null>(null);
  const [countsErr, setCountsErr] = useState<string | null>(null);

  const [listOpen, setListOpen] = useState(false);
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listBusy, setListBusy] = useState(false);

  const filtersKey = JSON.stringify(filters ?? {});

  // DB の中身は取り込み・削除で変わる。タブを開いたとき・他の窓で変更があったとき・↻ を押したときに数え直す。
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (active) setTick((x) => x + 1);
  }, [active]);
  // 手動の再集計と他の窓での変更は、開いている一覧・外した選択も捨てる（UID が変わりうる）。タブの出入りでは捨てない。
  const refreshAll = () => {
    setStudies(null);
    setExcluded(new Set());
    setTick((x) => x + 1);
  };
  useEffect(() => subscribeDbChanged(() => refreshAll()), []);
  const scope = useMemo(() => buildScope(filters ?? {}, studies, excluded), [filters, studies, excluded]);
  const scopeKey = JSON.stringify(scope);

  // 条件を変えたら、開いていた一覧と除外は無効（別の集合になる）。
  useEffect(() => {
    setStudies(null);
    setExcluded(new Set());
  }, [filtersKey]);

  // 親へ対象を伝える。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current(scope, scopeKey);
  }, [scope, scopeKey]);

  // 規模の問い合わせ（入力が止まってから）。除外があればその UID 集合の規模を出す。
  useEffect(() => {
    setCountsErr(null);
    let alive = true;
    const h = setTimeout(() => {
      seriesExtractScope(scope.studyUids ? { studyUids: scope.studyUids } : { filters: scope.filters ?? {} })
        .then((c) => alive && setCounts(c))
        .catch(() => alive && (setCounts(null), setCountsErr(t("seriesext.scope.err"))));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [scopeKey, tick, t]);

  const tooMany = counts !== null && counts.studies > LIST_CAP;

  // 一覧は開いたときに読む（絞り込みなしで大きな DB の全件を取りに行かない）。
  useEffect(() => {
    if (!listOpen || studies !== null || tooMany || counts === null) return;
    let alive = true;
    setListBusy(true);
    fetchStudies(filters ?? {})
      .then((ss) => {
        if (!alive) return;
        setStudies(ss);
        setExpanded(ss.length <= 200 ? new Set(ss.map((s) => s.patientId)) : new Set());
      })
      .catch(() => alive && setCountsErr(t("seriesext.scope.err")))
      .finally(() => alive && setListBusy(false));
    return () => {
      alive = false;
    };
  }, [listOpen, studies, tooMany, counts, filters, t]);

  const groups = useMemo(() => (studies ? groupByPatient(studies) : []), [studies]);
  const set = (patch: StudyFilters) => setF((p) => ({ ...p, ...patch }));
  const selectedStudies = studies ? studies.length - excluded.size : null;

  return (
    <div data-testid="series-extractor-scope" style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{t("seriesext.scope.title")}</span>
        <input data-testid="series-scope-patient-id" style={{ ...inp, width: 120 }} value={f.patientId ?? ""} onChange={(e) => set({ patientId: e.target.value })} placeholder={t("seriesext.scope.patientId")} spellCheck={false} />
        <input data-testid="series-scope-patient-name" style={{ ...inp, width: 130 }} value={f.patientName ?? ""} onChange={(e) => set({ patientName: e.target.value })} placeholder={t("seriesext.scope.patientName")} spellCheck={false} />
        <input style={{ ...inp, width: 132 }} type="date" value={fromDa(f.studyDateFrom)} onChange={(e) => set({ studyDateFrom: toDa(e.target.value) })} title={t("seriesext.scope.dateFrom")} />
        <span style={{ color: "#8a98a6" }}>〜</span>
        <input style={{ ...inp, width: 132 }} type="date" value={fromDa(f.studyDateTo)} onChange={(e) => set({ studyDateTo: toDa(e.target.value) })} title={t("seriesext.scope.dateTo")} />
        <input style={{ ...inp, width: 90 }} value={f.modality ?? ""} onChange={(e) => set({ modality: e.target.value.toUpperCase() })} placeholder="CT,MR" title={t("seriesext.scope.modality")} spellCheck={false} />
        <button style={miniBtn} onClick={() => setF({})} disabled={!filters} title={t("seriesext.scope.clear")}>
          ✕
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
        <span data-testid="series-scope-counts" style={{ fontSize: 12.5, color: "#33404d" }}>
          {!filters && counts && <b style={{ marginRight: 6 }}>{t("seriesext.scope.all")}</b>}
          {counts
            ? counts.series >= 0
              ? t("seriesext.scope.counts", { studies: counts.studies, series: counts.series, instances: counts.instances })
              : t("seriesext.scope.countsStudiesOnly", { studies: counts.studies })
            : countsErr ?? t("seriesext.scope.counting")}
          {selectedStudies !== null && excluded.size > 0 && (
            <span style={{ color: "#0b5cad", marginLeft: 8 }}>{t("seriesext.scope.selected", { n: selectedStudies, total: studies?.length ?? 0 })}</span>
          )}
        </span>
        <button data-testid="series-scope-refresh" style={miniBtn} onClick={refreshAll} title={t("seriesext.scope.refresh")}>
          ↻
        </button>
        <button data-testid="series-scope-pick-btn" style={btn} onClick={() => setListOpen((o) => !o)}>
          {listOpen ? t("seriesext.scope.pickClose") : t("seriesext.scope.pick")}
        </button>
        {counts && counts.series >= 0 && isLargeScope(counts.series) && (
          <span data-testid="series-scope-large" style={warn}>
            {t("seriesext.scope.large")}
          </span>
        )}
      </div>

      {listOpen && (
        <div data-testid="series-scope-list" style={listBox}>
          {tooMany && <div style={note}>{t("seriesext.scope.tooMany", { max: LIST_CAP })}</div>}
          {!tooMany && listBusy && <div style={note}>{t("seriesext.scope.loading")}</div>}
          {!tooMany && studies && studies.length === 0 && <div style={note}>{t("tagext.err.noStudies")}</div>}
          {!tooMany &&
            groups.map((g) => (
              <div key={g.patientId}>
                <div style={patientRow}>
                  <TriCheckbox state={patientState(g, excluded)} onChange={() => setExcluded(togglePatient(excluded, g))} testId={`series-scope-patient-${g.patientId}`} />
                  <button
                    style={{ ...linkBtn, width: 16 }}
                    onClick={() =>
                      setExpanded((p) => {
                        const n = new Set(p);
                        if (n.has(g.patientId)) n.delete(g.patientId);
                        else n.add(g.patientId);
                        return n;
                      })
                    }
                    aria-label="expand"
                  >
                    {expanded.has(g.patientId) ? "▾" : "▸"}
                  </button>
                  <span style={{ fontWeight: 600 }}>{g.patientId}</span>
                  <span style={{ color: "#8a98a6" }}>{g.patientName}</span>
                  <span style={{ color: "#8a98a6", marginLeft: "auto" }}>{g.studies.length}</span>
                </div>
                {expanded.has(g.patientId) &&
                  g.studies.map((s) => (
                    <label key={s.studyInstanceUid} style={studyRow}>
                      <input type="checkbox" data-testid={`series-scope-study-${s.studyInstanceUid}`} checked={!excluded.has(s.studyInstanceUid)} onChange={() => setExcluded(toggleStudy(excluded, s.studyInstanceUid))} />
                      <span style={{ fontFamily: "monospace" }}>{s.studyDate ?? "—"}</span>
                      <span style={{ color: "#5b6b7a" }}>{(s.modalities && s.modalities.length ? s.modalities : [s.modality ?? ""]).join("/")}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.studyDescription ?? ""}</span>
                      <span style={{ color: "#8a98a6" }}>{s.numberOfInstances}</span>
                    </label>
                  ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

const box: React.CSSProperties = { background: "#f3f6f9", border: "1px solid #e1e7ee", borderRadius: 6, padding: "8px 10px" };
const inp: React.CSSProperties = { padding: "4px 7px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 12.5, boxSizing: "border-box", background: "#fff" };
const btn: React.CSSProperties = { padding: "4px 12px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12.5, whiteSpace: "nowrap" };
const miniBtn: React.CSSProperties = { minWidth: 26, padding: "3px 7px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12 };
const linkBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#556", padding: 0 };
const warn: React.CSSProperties = { fontSize: 12, color: "#8a5a00", background: "#fff4d6", border: "1px solid #f0dca0", borderRadius: 5, padding: "2px 8px" };
const listBox: React.CSSProperties = { marginTop: 8, maxHeight: 220, overflow: "auto", background: "#fff", border: "1px solid #e1e7ee", borderRadius: 6 };
const note: React.CSSProperties = { padding: 8, fontSize: 12, color: "#5b6b7a" };
const patientRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#f7f9fb", borderBottom: "1px solid #eef1f4", fontSize: 12.5 };
const studyRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "3px 8px 3px 36px", borderBottom: "1px solid #f4f6f8", fontSize: 12.5, cursor: "pointer" };
