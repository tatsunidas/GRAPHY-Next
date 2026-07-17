/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import {
  fetchPatients,
  fetchStats,
  savePatient,
  deletePatient,
  deleteStudy,
  deleteSeries,
  deleteInstance,
  updateStudyPatient,
  mergeSeries,
  splitSeries,
  type Patient,
  type Stats,
  type SplitGroup,
} from "./dbAdminApi";
import { fetchSettings } from "../settings/settingsApi";
import { fetchInstances, fetchSeries, fetchStudies, type Instance, type Series, type Study } from "../api";
import { emitDbChanged, type DbChangedDetail } from "../dbEvents";
import { VBarChart, HBarChart, PieChart, formatBytes } from "./charts";
import { useI18n } from "../i18n/i18n";

type Tab = "patients" | "stats";

export function DbAdminDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** 編集/削除の成功時に呼ばれる（同一ウィンドウの一覧再読込用）。 */
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("patients");
  const [confirmDelete, setConfirmDelete] = useState(true);

  useEffect(() => {
    if (!open) return;
    fetchSettings()
      .then((s) => setConfirmDelete(s["data.confirmBeforeDelete"] !== "false"))
      .catch(() => setConfirmDelete(true));
  }, [open]);

  if (!open) return null;

  // 他ウィンドウへ通知（dbEvents）＋同一ウィンドウへ通知（onChanged）。
  const notify = (detail: Omit<DbChangedDetail, "ts">) => {
    emitDbChanged(detail);
    onChanged?.();
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div data-testid="dbadmin-dialog" style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("dbadmin.title")}</span>
          <button data-testid="dialog-close-button" style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        <div style={tabs}>
          <TabBtn active={tab === "patients"} onClick={() => setTab("patients")}>
            {t("dbadmin.tab.patients")}
          </TabBtn>
          <TabBtn active={tab === "stats"} onClick={() => setTab("stats")}>
            {t("dbadmin.tab.stats")}
          </TabBtn>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
          {tab === "patients" ? <PatientsTab confirmDelete={confirmDelete} notify={notify} /> : <StatsTab />}
        </div>
      </div>
    </div>
  );
}

function PatientsTab({
  confirmDelete,
  notify,
}: {
  confirmDelete: boolean;
  notify: (detail: Omit<DbChangedDetail, "ts">) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ドリルダウン（Patient → Study → Series）
  const [expandedPatients, setExpandedPatients] = useState<Set<string>>(new Set());
  const [studiesByPatient, setStudiesByPatient] = useState<Map<string, Study[]>>(new Map());
  const [expandedStudies, setExpandedStudies] = useState<Set<string>>(new Set());
  const [seriesByStudy, setSeriesByStudy] = useState<Map<string, Series[]>>(new Map());
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());
  const [instancesBySeries, setInstancesBySeries] = useState<Map<string, Instance[]>>(new Map());

  const [editingPatient, setEditingPatient] = useState<Patient | null>(null); // 患者全体編集
  const [editingStudy, setEditingStudy] = useState<{ study: Study; patient: Patient } | null>(null); // スタディ単位編集
  // シリーズ統合の選択（study 単位）と統合フォーム。
  const [seriesSel, setSeriesSel] = useState<Map<string, Set<string>>>(new Map());
  const [merging, setMerging] = useState<{ study: Study; series: Series[] } | null>(null);
  const [splitting, setSplitting] = useState<{ study: Study; series: Series } | null>(null);

  const reload = (query: string) => {
    setError(null);
    setStudiesByPatient(new Map());
    setSeriesByStudy(new Map());
    setInstancesBySeries(new Map());
    setExpandedPatients(new Set());
    setExpandedStudies(new Set());
    setExpandedSeries(new Set());
    // 全件取得は処理容量上危険なため、検索語が空のときは取得しない（初期は非表示）。
    const qq = query.trim();
    if (!qq) {
      setPatients(null);
      return;
    }
    setLoading(true);
    fetchPatients(qq)
      .then((ps) => setPatients(ps))
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };
  // 開いた直後は自動取得しない（検索を促す）。

  const togglePatient = async (pid: string) => {
    const next = new Set(expandedPatients);
    if (next.has(pid)) next.delete(pid);
    else {
      next.add(pid);
      if (!studiesByPatient.has(pid)) {
        try {
          const studies = await fetchStudies({ patientId: pid });
          setStudiesByPatient((m) => new Map(m).set(pid, studies));
        } catch (e) {
          setError(String(e));
        }
      }
    }
    setExpandedPatients(next);
  };

  const toggleStudy = async (studyUid: string) => {
    const next = new Set(expandedStudies);
    if (next.has(studyUid)) next.delete(studyUid);
    else {
      next.add(studyUid);
      if (!seriesByStudy.has(studyUid)) {
        try {
          const series = await fetchSeries(studyUid);
          setSeriesByStudy((m) => new Map(m).set(studyUid, series));
        } catch (e) {
          setError(String(e));
        }
      }
    }
    setExpandedStudies(next);
  };

  const onDeletePatient = async (p: Patient) => {
    if (confirmDelete && !window.confirm(t("dbadmin.delete.confirm", { name: p.patientName || p.patientId }))) return;
    try {
      await deletePatient(p.patientId);
      notify({ reason: "patient-delete", patientId: p.patientId });
      reload(q);
    } catch (e) {
      setError(String(e));
    }
  };

  const onDeleteStudy = async (p: Patient, s: Study) => {
    if (confirmDelete && !window.confirm(t("dbadmin.delete.studyConfirm", { desc: studyLabel(s) }))) return;
    try {
      await deleteStudy(s.studyInstanceUid);
      notify({ reason: "study-delete", patientId: p.patientId, studyUids: [s.studyInstanceUid] });
      setStudiesByPatient((m) => new Map(m).set(p.patientId, (m.get(p.patientId) ?? []).filter((x) => x.studyInstanceUid !== s.studyInstanceUid)));
      reload(q);
    } catch (e) {
      setError(String(e));
    }
  };

  const reloadSeries = async (studyUid: string) => {
    try {
      const series = await fetchSeries(studyUid);
      setSeriesByStudy((m) => new Map(m).set(studyUid, series));
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleSeriesSel = (studyUid: string, seriesUid: string) => {
    setSeriesSel((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(studyUid) ?? []);
      if (set.has(seriesUid)) set.delete(seriesUid);
      else set.add(seriesUid);
      next.set(studyUid, set);
      return next;
    });
  };

  const onDeleteSeries = async (p: Patient, s: Study, se: Series) => {
    if (confirmDelete && !window.confirm(t("dbadmin.delete.seriesConfirm", { desc: seriesLabel(se) }))) return;
    try {
      await deleteSeries(s.studyInstanceUid, se.seriesInstanceUid);
      notify({ reason: "series-delete", patientId: p.patientId, studyUids: [s.studyInstanceUid] });
      setSeriesByStudy((m) => new Map(m).set(s.studyInstanceUid, (m.get(s.studyInstanceUid) ?? []).filter((x) => x.seriesInstanceUid !== se.seriesInstanceUid)));
      reload(q);
    } catch (e) {
      setError(String(e));
    }
  };

  // シリーズ → インスタンス（画像）のドリルダウン。展開時に未取得なら取得する。
  const toggleSeriesInstances = async (studyUid: string, seriesUid: string) => {
    const next = new Set(expandedSeries);
    if (next.has(seriesUid)) next.delete(seriesUid);
    else {
      next.add(seriesUid);
      if (!instancesBySeries.has(seriesUid)) {
        try {
          const insts = await fetchInstances(studyUid, seriesUid);
          setInstancesBySeries((m) => new Map(m).set(seriesUid, insts));
        } catch (e) {
          setError(String(e));
        }
      }
    }
    setExpandedSeries(next);
  };

  const onDeleteInstance = async (p: Patient, s: Study, se: Series, inst: Instance) => {
    if (confirmDelete && !window.confirm(t("dbadmin.delete.instanceConfirm", { desc: instanceLabel(inst) }))) return;
    try {
      await deleteInstance(s.studyInstanceUid, se.seriesInstanceUid, inst.sopInstanceUid);
      notify({ reason: "instance-delete", patientId: p.patientId, studyUids: [s.studyInstanceUid] });
      // ローカル更新: 当該シリーズのインスタンス一覧から除去 → シリーズ件数（0なら消える）→ 患者件数。
      setInstancesBySeries((m) =>
        new Map(m).set(se.seriesInstanceUid, (m.get(se.seriesInstanceUid) ?? []).filter((x) => x.sopInstanceUid !== inst.sopInstanceUid)),
      );
      await reloadSeries(s.studyInstanceUid);
      reload(q);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          data-testid="dbadmin-search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && reload(q)}
          placeholder={t("dbadmin.search.placeholder")}
          style={input}
        />
        <button data-testid="dbadmin-search-button" onClick={() => reload(q)} style={btn}>
          {t("common.search")}
        </button>
      </div>

      {error && <div style={{ color: "#b00020", marginBottom: 8 }}>{error}</div>}
      {loading && <div>{t("common.loading")}</div>}
      {!loading && !patients && <div style={{ color: "#888" }}>{t("dbadmin.searchPrompt")}</div>}
      {!loading && patients && patients.length === 0 && <div style={{ color: "#666" }}>{t("dbadmin.patients.empty")}</div>}

      {!loading && patients && patients.length > 0 && (
        <div style={{ fontSize: 13 }}>
          {patients.map((p) => {
            const pExpanded = expandedPatients.has(p.patientId);
            const studies = studiesByPatient.get(p.patientId);
            return (
              <div key={p.patientId} style={{ borderBottom: "1px solid #eef1f4" }}>
                <div style={rowFlex}>
                  <button
                    data-testid={`dbadmin-patient-expand-${p.patientId}`}
                    style={expander}
                    onClick={() => void togglePatient(p.patientId)}
                    aria-label="expand"
                  >
                    {pExpanded ? "▾" : "▸"}
                  </button>
                  <span style={{ flex: 1 }}>
                    <b>{p.patientName || "—"}</b>
                    <span style={muted}> {p.patientId}</span>
                    <span style={muted}>
                      {" "}
                      ({t("field.studyCount")}: {p.numberOfStudies} / {t("field.instanceCount")}: {p.numberOfInstances})
                    </span>
                  </span>
                  <button onClick={() => setEditingPatient(p)} style={smallBtn}>
                    {t("dbadmin.edit.patientAll")}
                  </button>
                  <button onClick={() => void onDeletePatient(p)} style={{ ...smallBtn, color: "#b00020" }}>
                    {t("common.delete")}
                  </button>
                </div>

                {pExpanded && (
                  <div style={{ paddingLeft: 24, paddingBottom: 6 }}>
                    {!studies && <div style={muted}>{t("common.loading")}</div>}
                    {studies?.length === 0 && <div style={muted}>{t("study.empty")}</div>}
                    {studies?.map((s) => {
                      const sExpanded = expandedStudies.has(s.studyInstanceUid);
                      const series = seriesByStudy.get(s.studyInstanceUid);
                      return (
                        <div key={s.studyInstanceUid}>
                          <div style={rowFlex}>
                            <button
                              data-testid={`dbadmin-study-expand-${s.studyInstanceUid}`}
                              style={expander}
                              onClick={() => void toggleStudy(s.studyInstanceUid)}
                              aria-label="expand"
                            >
                              {sExpanded ? "▾" : "▸"}
                            </button>
                            <span style={{ flex: 1 }}>
                              {studyLabel(s)}
                              <span style={muted}> ({s.numberOfInstances})</span>
                            </span>
                            <button
                              data-testid={`dbadmin-study-edit-${s.studyInstanceUid}`}
                              onClick={() => setEditingStudy({ study: s, patient: p })}
                              style={smallBtn}
                            >
                              {t("dbadmin.edit.patientStudy")}
                            </button>
                            <button onClick={() => void onDeleteStudy(p, s)} style={{ ...smallBtn, color: "#b00020" }}>
                              {t("common.delete")}
                            </button>
                          </div>
                          {sExpanded && (
                            <div style={{ paddingLeft: 24 }}>
                              {!series && <div style={muted}>{t("common.loading")}</div>}
                              {series?.length === 0 && <div style={muted}>{t("series.empty")}</div>}
                              {(() => {
                                const sel = seriesSel.get(s.studyInstanceUid) ?? new Set<string>();
                                return (
                                  <>
                                    {(series?.length ?? 0) >= 2 && (
                                      <div style={mergeBar}>
                                        <span style={{ fontSize: 12, color: "#556" }}>
                                          {t("dbadmin.merge.selected", { count: sel.size })}
                                        </span>
                                        <button
                                          data-testid={`dbadmin-merge-open-${s.studyInstanceUid}`}
                                          disabled={sel.size < 2}
                                          onClick={() =>
                                            setMerging({
                                              study: s,
                                              series: (series ?? []).filter((x) => sel.has(x.seriesInstanceUid)),
                                            })
                                          }
                                          style={{ ...smallBtn, opacity: sel.size < 2 ? 0.5 : 1 }}
                                        >
                                          {t("dbadmin.merge.button")}
                                        </button>
                                      </div>
                                    )}
                                    {series?.map((se) => {
                                      const seExpanded = expandedSeries.has(se.seriesInstanceUid);
                                      const insts = instancesBySeries.get(se.seriesInstanceUid);
                                      return (
                                        <div key={se.seriesInstanceUid}>
                                          <div style={rowFlex}>
                                            <input
                                              data-testid={`dbadmin-series-checkbox-${se.seriesInstanceUid}`}
                                              type="checkbox"
                                              checked={sel.has(se.seriesInstanceUid)}
                                              onChange={() => toggleSeriesSel(s.studyInstanceUid, se.seriesInstanceUid)}
                                            />
                                            <button
                                              style={expander}
                                              onClick={() => void toggleSeriesInstances(s.studyInstanceUid, se.seriesInstanceUid)}
                                              aria-label="expand"
                                            >
                                              {seExpanded ? "▾" : "▸"}
                                            </button>
                                            <span style={{ flex: 1 }}>
                                              {seriesLabel(se)}
                                              <span style={muted}> ({se.numberOfInstances})</span>
                                            </span>
                                            {se.numberOfInstances >= 2 && (
                                              <button
                                                data-testid={`dbadmin-series-split-${se.seriesInstanceUid}`}
                                                onClick={() => setSplitting({ study: s, series: se })}
                                                style={smallBtn}
                                              >
                                                {t("dbadmin.split.button")}
                                              </button>
                                            )}
                                            <button
                                              data-testid={`dbadmin-series-delete-${se.seriesInstanceUid}`}
                                              onClick={() => void onDeleteSeries(p, s, se)}
                                              style={{ ...smallBtn, color: "#b00020" }}
                                            >
                                              {t("common.delete")}
                                            </button>
                                          </div>
                                          {seExpanded && (
                                            <div style={{ paddingLeft: 24 }}>
                                              {!insts && <div style={muted}>{t("common.loading")}</div>}
                                              {insts?.length === 0 && <div style={muted}>{t("series.empty")}</div>}
                                              {insts?.map((inst) => (
                                                <div key={inst.sopInstanceUid} style={rowFlex}>
                                                  <span style={{ flex: 1 }}>{instanceLabel(inst)}</span>
                                                  <button
                                                    onClick={() => void onDeleteInstance(p, s, se, inst)}
                                                    style={{ ...smallBtn, color: "#b00020" }}
                                                  >
                                                    {t("common.delete")}
                                                  </button>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingPatient && (
        <PatientEditForm
          patient={editingPatient}
          onClose={() => setEditingPatient(null)}
          onSaved={(detail) => {
            setEditingPatient(null);
            notify(detail);
            reload(q);
          }}
        />
      )}
      {editingStudy && (
        <StudyPatientEditForm
          study={editingStudy.study}
          patient={editingStudy.patient}
          onClose={() => setEditingStudy(null)}
          onSaved={(detail) => {
            setEditingStudy(null);
            notify(detail);
            reload(q);
          }}
        />
      )}
      {merging && (
        <MergeSeriesForm
          study={merging.study}
          series={merging.series}
          onClose={() => setMerging(null)}
          onMerged={async () => {
            const studyUid = merging.study.studyInstanceUid;
            setMerging(null);
            setSeriesSel((prev) => {
              const next = new Map(prev);
              next.delete(studyUid);
              return next;
            });
            notify({ reason: "series-merge", studyUids: [studyUid] });
            await reloadSeries(studyUid);
            reload(q);
          }}
        />
      )}
      {splitting && (
        <SplitSeriesForm
          study={splitting.study}
          series={splitting.series}
          onClose={() => setSplitting(null)}
          onSplit={async () => {
            const studyUid = splitting.study.studyInstanceUid;
            setSplitting(null);
            notify({ reason: "series-split", studyUids: [studyUid] });
            await reloadSeries(studyUid);
            reload(q);
          }}
        />
      )}
    </div>
  );
}

/** シリーズ分割フォーム（各インスタンスを群へ割当。どの群にも入れなければ元シリーズに残る）。 */
function SplitSeriesForm({
  study,
  series,
  onClose,
  onSplit,
}: {
  study: Study;
  series: Series;
  onClose: () => void;
  onSplit: () => void;
}) {
  const { t } = useI18n();
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [groupCount, setGroupCount] = useState(2);
  const [assign, setAssign] = useState<Map<string, number>>(new Map()); // sop -> 0(=残す) / 1..N
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchInstances(study.studyInstanceUid, series.seriesInstanceUid)
      .then(setInstances)
      .catch((e: unknown) => setError(String(e)));
  }, [study.studyInstanceUid, series.seriesInstanceUid]);

  const setGroup = (sop: string, g: number) => setAssign((prev) => new Map(prev).set(sop, g));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const groups: SplitGroup[] = [];
      for (let g = 1; g <= groupCount; g++) {
        const sops = (instances ?? [])
          .filter((i) => (assign.get(i.sopInstanceUid) ?? 0) === g)
          .map((i) => i.sopInstanceUid);
        if (sops.length > 0) groups.push({ sopInstanceUids: sops });
      }
      if (groups.length === 0) {
        setError(t("dbadmin.split.noGroups"));
        setBusy(false);
        return;
      }
      const r = await splitSeries(study.studyInstanceUid, series.seriesInstanceUid, groups);
      if (r.failed > 0) {
        setError(t("dbadmin.split.partial", { moved: r.moved, failed: r.failed }));
        setBusy(false);
        return;
      }
      onSplit();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div
        data-testid="dbadmin-split-form"
        style={{ ...editBox, width: 540, maxHeight: "86vh", display: "flex", flexDirection: "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 6px" }}>{t("dbadmin.split.title")}</h3>
        <p style={{ fontSize: 12, color: "#8a98a6", marginTop: 0 }}>{t("dbadmin.split.note")}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: "#445" }}>{t("dbadmin.split.groupCount")}</span>
          <select
            data-testid="dbadmin-split-groupcount"
            value={groupCount}
            onChange={(e) => setGroupCount(Number(e.target.value))}
            style={{ ...input, width: 80 }}
          >
            {[2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, overflow: "auto", border: "1px solid #eef1f4", borderRadius: 6 }}>
          {!instances && <div style={{ padding: 10, color: "#888" }}>{t("common.loading")}</div>}
          {instances?.map((i) => (
            <div key={i.sopInstanceUid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", borderBottom: "1px solid #f3f5f7", fontSize: 12 }}>
              <span style={{ flex: 1 }}>#{i.instanceNumber ?? "?"}</span>
              <select
                data-testid={`dbadmin-split-assign-${i.sopInstanceUid}`}
                value={assign.get(i.sopInstanceUid) ?? 0}
                onChange={(e) => setGroup(i.sopInstanceUid, Number(e.target.value))}
                style={{ ...input, width: 130 }}
              >
                <option value={0}>{t("dbadmin.split.keep")}</option>
                {Array.from({ length: groupCount }, (_, k) => k + 1).map((g) => (
                  <option key={g} value={g}>
                    {t("dbadmin.split.group", { n: g })}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        {error && <div style={{ color: "#b00020", marginTop: 6 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={btn}>
            {t("common.cancel")}
          </button>
          <button data-testid="dbadmin-split-run" onClick={run} disabled={busy} style={{ ...btn, background: "#0b5cad", color: "#fff" }}>
            {busy ? t("dbadmin.split.running") : t("dbadmin.split.button")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** シリーズ統合フォーム（統合先 SeriesNumber/Description）。 */
function MergeSeriesForm({
  study,
  series,
  onClose,
  onMerged,
}: {
  study: Study;
  series: Series[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const { t } = useI18n();
  const first = series[0];
  const [number, setNumber] = useState(String(first?.seriesNumber ?? 1));
  const [desc, setDesc] = useState(first?.seriesDescription ?? "Merged");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = Number.parseInt(number, 10);
      const r = await mergeSeries(
        study.studyInstanceUid,
        series.map((s) => s.seriesInstanceUid),
        { seriesNumber: Number.isFinite(n) ? n : undefined, seriesDescription: desc },
      );
      if (r.failed > 0) {
        setError(t("dbadmin.merge.partial", { moved: r.moved, failed: r.failed }));
        setBusy(false);
        return;
      }
      onMerged();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div data-testid="dbadmin-merge-form" style={editBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 6px" }}>{t("dbadmin.merge.title")}</h3>
        <p style={{ fontSize: 12, color: "#8a98a6", marginTop: 0 }}>
          {t("dbadmin.merge.note", { count: series.length })}
        </p>
        <div style={{ maxHeight: 120, overflow: "auto", border: "1px solid #eef1f4", borderRadius: 6, padding: "6px 8px", marginBottom: 8 }}>
          {series.map((s) => (
            <div key={s.seriesInstanceUid} style={{ fontSize: 12, color: "#445" }}>
              • {seriesLabel(s)} <span style={muted}>({s.numberOfInstances})</span>
            </div>
          ))}
        </div>
        <Row label={t("dbadmin.merge.seriesNumber")}>
          <input data-testid="dbadmin-merge-seriesnumber" value={number} onChange={(e) => setNumber(e.target.value)} style={input} />
        </Row>
        <Row label={t("field.description")}>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} style={input} />
        </Row>
        {error && <div style={{ color: "#b00020", marginTop: 6 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={btn}>
            {t("common.cancel")}
          </button>
          <button data-testid="dbadmin-merge-run" onClick={run} disabled={busy} style={{ ...btn, background: "#0b5cad", color: "#fff" }}>
            {busy ? t("dbadmin.merge.running") : t("dbadmin.merge.button")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 患者全体の編集（全スタディに適用）。 */
function PatientEditForm({
  patient,
  onClose,
  onSaved,
}: {
  patient: Patient;
  onClose: () => void;
  onSaved: (detail: Omit<DbChangedDetail, "ts">) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(patient.patientName ?? "");
  const [birth, setBirth] = useState(patient.patientBirthDate ?? "");
  const [sex, setSex] = useState(patient.patientSex ?? "");
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await savePatient(patient.patientId, { patientName: name, patientBirthDate: birth, patientSex: sex, newPatientId: newId });
      onSaved({ reason: "patient-edit", patientId: newId || patient.patientId });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={editBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 6px" }}>{t("dbadmin.edit.title")}</h3>
        <p style={{ fontSize: 12, color: "#8a98a6", marginTop: 0 }}>{t("dbadmin.edit.note")}</p>
        <PatientFields {...{ name, setName, birth, setBirth, sex, setSex }} />
        <Row label={t("dbadmin.edit.newId")}>
          <input value={newId} onChange={(e) => setNewId(e.target.value)} style={input} placeholder={patient.patientId} />
        </Row>
        {error && <div style={{ color: "#b00020", marginTop: 6 }}>{error}</div>}
        <FormButtons onClose={onClose} onSave={save} saving={saving} />
      </div>
    </div>
  );
}

/** スタディ単位の患者編集（そのスタディのみ。PatientID 変更で別患者へ移動）。 */
function StudyPatientEditForm({
  study,
  patient,
  onClose,
  onSaved,
}: {
  study: Study;
  patient: Patient;
  onClose: () => void;
  onSaved: (detail: Omit<DbChangedDetail, "ts">) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(study.patientName ?? patient.patientName ?? "");
  const [birth, setBirth] = useState(patient.patientBirthDate ?? "");
  const [sex, setSex] = useState(patient.patientSex ?? "");
  const [newId, setNewId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const moving = newId.trim() !== "" && newId.trim() !== patient.patientId;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateStudyPatient(study.studyInstanceUid, { patientName: name, patientBirthDate: birth, patientSex: sex, newPatientId: newId });
      onSaved({ reason: "study-patient-edit", patientId: newId || patient.patientId, studyUids: [study.studyInstanceUid] });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div data-testid="dbadmin-study-edit-form" style={editBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 6px" }}>{t("dbadmin.edit.studyTitle")}</h3>
        <p style={{ fontSize: 12, color: "#8a98a6", marginTop: 0 }}>
          {t("dbadmin.edit.studyNote", { desc: studyLabel(study) })}
        </p>
        <PatientFields {...{ name, setName, birth, setBirth, sex, setSex }} />
        <Row label={t("dbadmin.edit.newId")}>
          <input
            data-testid="dbadmin-study-edit-newid"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            style={input}
            placeholder={patient.patientId}
          />
        </Row>
        {moving && <div style={{ color: "#8a6d00", fontSize: 12, marginTop: 6 }}>{t("dbadmin.edit.moveWarn", { id: newId.trim() })}</div>}
        {error && <div style={{ color: "#b00020", marginTop: 6 }}>{error}</div>}
        <FormButtons onClose={onClose} onSave={save} saving={saving} />
      </div>
    </div>
  );
}

function PatientFields({
  name,
  setName,
  birth,
  setBirth,
  sex,
  setSex,
}: {
  name: string;
  setName: (v: string) => void;
  birth: string;
  setBirth: (v: string) => void;
  sex: string;
  setSex: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Row label={t("field.patientName")}>
        <input value={name} onChange={(e) => setName(e.target.value)} style={input} />
      </Row>
      <Row label={t("dbadmin.edit.birthDate")}>
        <input value={birth} onChange={(e) => setBirth(e.target.value)} style={input} placeholder="19800101" />
      </Row>
      <Row label={t("field.sex")}>
        <select value={sex} onChange={(e) => setSex(e.target.value)} style={input}>
          <option value="">—</option>
          <option value="M">M</option>
          <option value="F">F</option>
          <option value="O">O</option>
        </select>
      </Row>
    </>
  );
}

function FormButtons({ onClose, onSave, saving }: { onClose: () => void; onSave: () => void; saving: boolean }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
      <button onClick={onClose} style={btn}>
        {t("common.cancel")}
      </button>
      <button data-testid="dbadmin-form-save" onClick={onSave} disabled={saving} style={{ ...btn, background: "#0b5cad", color: "#fff" }}>
        {saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  );
}

function StatsTab() {
  const { t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) return <div style={{ color: "#b00020" }}>{error}</div>;
  if (!stats) return <div>{t("common.loading")}</div>;

  const toData = (b: { key: string; value: number }[]) => b.map((x) => ({ label: x.key, value: x.value }));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
      <Card title={t("dbadmin.stats.studyByMonth")}>
        <VBarChart data={toData(stats.studyCountByMonth)} />
      </Card>
      <Card title={t("dbadmin.stats.modalityRatio")}>
        <PieChart data={toData(stats.studyCountByModality)} />
      </Card>
      <Card title={t("dbadmin.stats.instanceByModality")}>
        <HBarChart data={toData(stats.instanceCountByModality)} />
      </Card>
      <Card title={t("dbadmin.stats.volumeByModality")}>
        <HBarChart data={toData(stats.volumeBytesByModality)} formatValue={formatBytes} />
      </Card>
    </div>
  );
}

// --- 小物 ---
function studyLabel(s: Study): string {
  return `${formatDate(s.studyDate)} / ${s.studyDescription || "—"}${s.modality ? ` (${s.modality})` : ""}`;
}
function seriesLabel(se: Series): string {
  return `#${se.seriesNumber ?? "—"} ${se.modality || ""} ${se.seriesDescription || "—"}`;
}
function instanceLabel(inst: Instance): string {
  return `#${inst.instanceNumber ?? "—"}  ${inst.sopInstanceUid}`;
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #eef1f4", borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "8px 0" }}>
      <div style={{ width: 150, fontSize: 13, color: "#445" }}>{label}</div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        padding: "10px 16px",
        cursor: "pointer",
        fontSize: 14,
        fontWeight: active ? 700 : 400,
        color: active ? "#0b5cad" : "#445",
        borderBottom: active ? "2px solid #0b5cad" : "2px solid transparent",
      }}
    >
      {children}
    </button>
  );
}
function formatDate(d: string | null): string {
  if (!d || d.length !== 8) return d || "—";
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 860,
  maxWidth: "94vw",
  height: 560,
  maxHeight: "90vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const tabs: React.CSSProperties = { display: "flex", borderBottom: "1px solid #eee", padding: "0 8px" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const input: React.CSSProperties = { padding: "6px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "6px 12px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const smallBtn: React.CSSProperties = { padding: "3px 8px", border: "1px solid #d7dde3", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, marginLeft: 4 };
const editBox: React.CSSProperties = { width: 460, maxWidth: "92vw", background: "#fff", borderRadius: 10, padding: 20, boxShadow: "0 12px 40px rgba(0,0,0,0.3)" };
const rowFlex: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "4px 0" };
const mergeBar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "4px 0 6px", marginBottom: 2 };
const expander: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 12, width: 16, color: "#667", padding: 0 };
const muted: React.CSSProperties = { color: "#8a98a6", fontSize: 11 };
