/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 計算ジョブの窓（#computejobs）。外部・自機の計算機で走るジョブの待ち・進み具合・失敗理由・中止・履歴を見る。
// backend の台帳（/api/compute/jobs）を読むだけ。患者名は台帳に無いので、表示のときに保管庫から UID で引く。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchStudies } from "../api";
import { desktop, type ComputeEndpointEntry } from "../desktopBridge";
import { useI18n, type TFn } from "../i18n/i18n";
import {
  cancelComputeBatch,
  cancelComputeJob,
  deleteComputeJob,
  fetchComputeJobs,
  fetchComputeLog,
  resumeComputeBatch,
  type ComputeJobView,
  type ComputeLogKind,
} from "./computeJobsApi";
import { loadSeen, markSeen, pruneSeen, saveSeen } from "./computeJobsSeen";
import {
  cleanupKey,
  countJobs,
  endpointLoads,
  envText,
  errorDetail,
  filterJobs,
  formatBytes,
  formatDuration,
  groupByBatch,
  isCancellable,
  isEnded,
  needsAttention,
  phaseKey,
  progressPct,
  reasonKey,
  sortNewest,
  stateKey,
  studyUidsOf,
  toMillis,
  type JobFilter,
} from "./computeJobsView";

const POLL_MS = 3000;
const NAME_CHUNK = 20;

interface StudyName {
  patientName: string | null;
  description: string | null;
  modality: string | null;
}

export function ComputeJobsScreen() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<ComputeJobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<ComputeEndpointEntry[]>([]);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [uncollectedOnly, setUncollectedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen());
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Map<string, StudyName>>(new Map());
  const [keepAwake, setKeepAwake] = useState(false);
  const [batchBusy, setBatchBusy] = useState<Set<string>>(new Set());
  const asked = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    try {
      const list = await fetchComputeJobs();
      setJobs(list);
      setError(null);
      setCancelling((c) => {
        if (c.size === 0) return c;
        const live = new Set(list.filter((j) => !isEnded(j.state)).map((j) => j.id));
        const next = new Set([...c].filter((id) => live.has(id)));
        return next.size === c.size ? c : next;
      });
      // 消えた行の確認済み印を掃除する。
      setSeen((s) => {
        const pruned = pruneSeen(s, list.map((j) => j.id));
        if (pruned.size !== s.size) saveSeen(pruned);
        return pruned.size === s.size ? s : pruned;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      const cfg = await desktop()?.computeEndpointsGet?.();
      if (cfg) setEndpoints(cfg.endpoints);
    } catch {
      /* 計算機の帯は無くても一覧は見える */
    }
    try {
      const r = await desktop()?.computeKeepAwakeStatus?.();
      setKeepAwake(r?.active === true);
    } catch {
      setKeepAwake(false);
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // 患者名・検査記述を、まだ引いていない検査だけ保管庫から引く（保存しない）。
  useEffect(() => {
    if (!jobs) return;
    const missing = studyUidsOf(jobs).filter((u) => !asked.current.has(u));
    if (missing.length === 0) return;
    missing.forEach((u) => asked.current.add(u));
    void (async () => {
      const found = new Map<string, StudyName>();
      for (let i = 0; i < missing.length; i += NAME_CHUNK) {
        try {
          const rows = await fetchStudies({ studyInstanceUid: missing.slice(i, i + NAME_CHUNK).join(",") });
          for (const s of rows) {
            found.set(s.studyInstanceUid, {
              patientName: s.patientName,
              description: s.studyDescription,
              modality: s.modalities?.join("/") ?? s.modality,
            });
          }
        } catch {
          missing.slice(i, i + NAME_CHUNK).forEach((u) => asked.current.delete(u)); // 次の周期で引き直す
        }
      }
      if (found.size > 0) setNames((prev) => new Map([...prev, ...found]));
    })();
  }, [jobs]);

  const sorted = useMemo(() => sortNewest(jobs ?? []), [jobs]);
  const visible = useMemo(() => filterJobs(sorted, filter, uncollectedOnly), [sorted, filter, uncollectedOnly]);
  const groups = useMemo(() => groupByBatch(visible), [visible]);
  const counts = useMemo(() => countJobs(jobs ?? [], seen), [jobs, seen]);
  const loads = useMemo(() => endpointLoads(jobs ?? []), [jobs]);
  const selected = sorted.find((j) => j.id === selectedId) ?? null;
  const totalBytes = useMemo(() => (jobs ?? []).reduce((a, j) => a + (j.outputsBytes ?? 0), 0), [jobs]);

  const select = (j: ComputeJobView) => {
    setSelectedId(j.id);
    if (needsAttention(j.state)) setSeen(markSeen(j.id));
  };

  const cancel = async (j: ComputeJobView) => {
    setCancelling((c) => new Set(c).add(j.id));
    try {
      await cancelComputeJob(j.id);
    } catch {
      setCancelling((c) => {
        const n = new Set(c);
        n.delete(j.id);
        return n;
      });
    }
    void poll();
  };

  const remove = async (j: ComputeJobView) => {
    try {
      await deleteComputeJob(j.id);
      if (selectedId === j.id) setSelectedId(null);
    } catch {
      /* 409（まだ終わっていない）は次の周期で状態が更新される */
    }
    void poll();
  };

  // 受け取り済みの完了・中止だけを消す。失敗・中断（確認が要る）と、未受け取りの結果は残す。
  const clearFinished = async () => {
    const targets = (jobs ?? []).filter(
      (j) => j.state === "CANCELLED" || (j.state === "DONE" && j.collectedAt != null),
    );
    for (const j of targets) {
      try {
        await deleteComputeJob(j.id);
      } catch {
        /* 続ける */
      }
    }
    if (selectedId && targets.some((j) => j.id === selectedId)) setSelectedId(null);
    void poll();
  };

  // 一括の［再開］［一括を中止］。押している間は二重に押せないようにする
  const batchAction = async (batchId: string, f: (id: string) => Promise<unknown>) => {
    setBatchBusy((b) => new Set(b).add(batchId));
    try {
      await f(batchId);
    } catch {
      /* 409（再開できない・もう終わっている）は次の周期の表示で分かる */
    }
    setBatchBusy((b) => {
      const n = new Set(b);
      n.delete(batchId);
      return n;
    });
    void poll();
  };

  const patientLabel = (j: ComputeJobView): string => {
    if (j.inputs.length === 0) return t("computeJobs.noInput");
    return j.inputs
      .map((i) => {
        if (i.deleted || !i.studyUid) return t("computeJobs.deletedSeries");
        const n = names.get(i.studyUid);
        if (!n) return t("computeJobs.loadingName");
        return [n.patientName, n.description].filter(Boolean).join(" ") || t("computeJobs.unnamed");
      })
      .join(" / ");
  };

  const filters: { id: JobFilter; label: string }[] = [
    { id: "all", label: t("computeJobs.filter.all") },
    { id: "active", label: t("computeJobs.filter.active") },
    { id: "failed", label: t("computeJobs.filter.failed") },
    { id: "done", label: t("computeJobs.filter.done") },
  ];

  const row = (j: ComputeJobView, indent: boolean) => {
    const pct = progressPct(j.progress);
    const ended = isEnded(j.state);
    const reason = reasonKey(j.reason);
    return (
      <tr
        key={j.id}
        data-testid={`computejobs-row-${j.id}`}
        data-state={j.state}
        onClick={() => select(j)}
        style={{ ...tr, background: j.id === selectedId ? "#e8f1fb" : undefined, cursor: "pointer" }}
      >
        <td style={{ ...td, paddingLeft: indent ? 24 : 8 }}>
          <div style={{ fontWeight: 600 }}>{patientLabel(j)}</div>
          <div style={{ color: "#667" }}>
            {j.pluginName ?? t("computeJobs.unknownPlugin")}
            {j.pluginVersion ? ` ${j.pluginVersion}` : ""}
            {j.attempt > 1 ? ` · ${t("computeJobs.attempt", { n: j.attempt })}` : ""}
          </div>
        </td>
        <td style={td}>{j.endpointLabel ?? "—"}</td>
        <td style={td} data-testid={`computejobs-status-${j.id}`}>
          <span style={{ color: stateColor(j.state), fontWeight: 600 }}>{t(stateKey(j.state))}</span>
          {j.state === "RUNNING" && phaseKey(j.phase) && <span> {t(phaseKey(j.phase) as string)}</span>}
          {j.state === "RUNNING" && pct != null && (
            <div style={barOuter}>
              <div style={{ ...barInner, width: `${pct}%` }} />
              <span style={{ marginLeft: 6 }}>{pct}%</span>
            </div>
          )}
          {j.state === "QUEUED" && <span style={{ color: "#667" }}> {t("computeJobs.queuedHint")}</span>}
          {(j.state === "FAILED" || j.state === "INTERRUPTED") && reason && (
            <div style={{ color: "#b00020" }}>
              {t(reason)}
              {j.reason === "code-error" && errorDetail(j) ? `: ${errorDetail(j)}` : ""}
            </div>
          )}
          {ended && j.state === "DONE" && j.collectedAt == null && (
            <span style={{ color: "#667" }}> · {t("computeJobs.uncollected")}</span>
          )}
          {ended && j.state === "DONE" && j.collectedAt != null && (
            <span data-testid={`computejobs-collected-${j.id}`} style={{ color: "#667" }}> · {t("computeJobs.collected")}</span>
          )}
        </td>
        <td style={td}>
          {isCancellable(j.state) && (
            <button
              data-testid={`computejobs-cancel-${j.id}`}
              disabled={cancelling.has(j.id)}
              onClick={(e) => {
                e.stopPropagation();
                void cancel(j);
              }}
            >
              {cancelling.has(j.id) ? t("computeJobs.cancelling") : t("computeJobs.cancel")}
            </button>
          )}
          {ended && (
            <button
              data-testid={`computejobs-delete-${j.id}`}
              onClick={(e) => {
                e.stopPropagation();
                void remove(j);
              }}
            >
              {t("computeJobs.delete")}
            </button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div style={page} data-testid="computejobs-screen">
      <div style={band} data-testid="computejobs-endpoints">
        <strong>{t("computeJobs.endpoints")}</strong>
        {endpoints.length === 0 && <span style={{ color: "#667" }}>{t("computeJobs.endpointsNone")}</span>}
        {endpoints.map((e) => {
          const load = loads.find((l) => l.endpointId === e.id);
          const busy = (load?.running ?? 0) + (load?.queued ?? 0) > 0;
          const colabState = e.kind === "colab" ? (e.runtime?.allocated ? t("computeJobs.runtimeOn") : t("computeJobs.runtimeOff")) : null;
          return (
            <span key={e.id} data-testid={`computejobs-endpoint-${e.id}`} style={chip}>
              <span style={{ color: busy ? "#0b5cad" : "#3fb950" }}>●</span> {e.label}
              {colabState && <span style={{ color: "#667" }}> ({colabState})</span>}
              {load && (
                <span style={{ color: "#667" }}>
                  {" "}
                  {t("computeJobs.load", { running: load.running, queued: load.queued })}
                </span>
              )}
            </span>
          );
        })}
      </div>

      <div style={toolbar}>
        {filters.map((f) => (
          <button
            key={f.id}
            data-testid={`computejobs-filter-${f.id}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            style={{ ...pill, ...(filter === f.id ? pillOn : {}) }}
          >
            {f.label}
          </button>
        ))}
        <label style={{ marginLeft: 8 }}>
          <input
            type="checkbox"
            data-testid="computejobs-uncollected"
            checked={uncollectedOnly}
            onChange={(e) => setUncollectedOnly(e.target.checked)}
          />{" "}
          {t("computeJobs.uncollectedOnly")}
        </label>
        <span style={{ flex: 1 }} />
        {keepAwake && (
          <span data-testid="computejobs-awake" style={{ color: "#667" }}>
            {t("computeJobs.awake")}
          </span>
        )}
        <span data-testid="computejobs-counts" style={{ color: "#445" }}>
          {t("computeJobs.bar.counts", { running: counts.running, queued: counts.queued, failed: counts.failed })}
        </span>
        <span style={{ color: "#667" }}>{t("computeJobs.outputsTotal", { size: formatBytes(totalBytes) ?? "—" })}</span>
        <button data-testid="computejobs-clear-finished" onClick={() => void clearFinished()}>
          {t("computeJobs.clearFinished")}
        </button>
      </div>

      {error && (
        <div data-testid="computejobs-error" style={{ padding: 12, color: "#b00020" }}>
          {t("computeJobs.error", { message: error })}
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={th}>{t("computeJobs.col.job")}</th>
              <th style={th}>{t("computeJobs.col.endpoint")}</th>
              <th style={th}>{t("computeJobs.col.status")}</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody data-testid="computejobs-list">
            {groups.map((g) =>
              g.isBatch || g.jobs.length > 1 ? (
                <Fragment key={g.batchId}>
                  <tr style={{ background: "#f0f3f6" }} data-testid={`computejobs-batch-${g.batchId}`}>
                    <td colSpan={3} style={{ ...td, fontWeight: 600 }}>
                      {t("computeJobs.batchSummary", {
                        n: g.jobs.length,
                        done: g.done,
                        failed: g.failed,
                        running: g.running,
                        queued: g.queued,
                      })}
                      {g.pausedReason && (
                        <span data-testid={`computejobs-batch-paused-${g.batchId}`} style={{ color: "#8a5a00", marginLeft: 12 }}>
                          {t("computeJobs.batchPaused", {
                            reason: reasonKey(g.pausedReason) ? t(reasonKey(g.pausedReason) as string) : g.pausedReason,
                          })}
                        </span>
                      )}
                    </td>
                    <td style={td}>
                      {g.isBatch && g.pausedReason && (
                        <button
                          data-testid={`computejobs-batch-resume-${g.batchId}`}
                          disabled={batchBusy.has(g.batchId)}
                          onClick={() => void batchAction(g.batchId, resumeComputeBatch)}
                          style={{ marginRight: 6 }}
                        >
                          {t("computeJobs.resume")}
                        </button>
                      )}
                      {g.isBatch && g.active && (
                        <button
                          data-testid={`computejobs-batch-cancel-${g.batchId}`}
                          disabled={batchBusy.has(g.batchId)}
                          onClick={() => void batchAction(g.batchId, cancelComputeBatch)}
                        >
                          {t("computeJobs.cancelBatch")}
                        </button>
                      )}
                    </td>
                  </tr>
                  {g.jobs.map((j) => row(j, true))}
                </Fragment>
              ) : (
                row(g.jobs[0], false)
              ),
            )}
            {jobs && visible.length === 0 && (
              <tr>
                <td colSpan={4} style={{ ...td, color: "#667" }} data-testid="computejobs-empty">
                  {t("computeJobs.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <JobDetail job={selected} t={t} patient={patientLabel(selected)} />}
    </div>
  );
}

function JobDetail({ job, t, patient }: { job: ComputeJobView; t: TFn; patient: string }) {
  const [log, setLog] = useState<{ kind: ComputeLogKind; text: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  // 別の行を選んだら、前の行のログは捨てる。
  useEffect(() => {
    setLog(null);
  }, [job.id]);

  const open = async (kind: ComputeLogKind) => {
    setBusy(true);
    try {
      setLog({ kind, text: await fetchComputeLog(job.id, kind) });
    } catch (e) {
      setLog({ kind, text: `${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const fmt = (v: string | number | null) => {
    const ms = toMillis(v);
    return ms == null ? null : new Date(ms).toLocaleTimeString();
  };
  const dur =
    toMillis(job.startedAt) != null
      ? formatDuration((toMillis(job.finishedAt) ?? Date.now()) - (toMillis(job.startedAt) as number))
      : null;
  const timeline = [
    [t("computeJobs.time.queued"), fmt(job.queuedAt)],
    [t("computeJobs.time.started"), fmt(job.startedAt)],
    [t("computeJobs.time.finished"), fmt(job.finishedAt)],
  ].filter((x): x is [string, string] => x[1] != null);
  const reason = reasonKey(job.reason);
  const cleanup = cleanupKey(job.remoteCleanup);

  return (
    <div style={detail} data-testid="computejobs-detail">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{patient}</div>
      <div data-testid="computejobs-detail-plugin">
        {t("computeJobs.detail.plugin")}: {job.pluginName ?? t("computeJobs.unknownPlugin")} {job.pluginVersion ?? ""}
        {" · "}
        {t("computeJobs.detail.packageSha")}: {job.pluginPackageSha256 ? short(job.pluginPackageSha256) : t("computeJobs.unknown")}
        {" · "}
        {t("computeJobs.detail.codeSha")}: {job.codeSha256 ? short(job.codeSha256) : t("computeJobs.unknown")}
      </div>
      <div>
        {t("computeJobs.detail.endpoint")}: {job.endpointLabel ?? "—"}
        {job.endpointHost ? ` (${job.endpointHost})` : ""}
        {job.plaintext ? ` · ${t("computeJobs.plaintext")}` : ""}
        {" · "}
        {t("computeJobs.detail.env")}:{" "}
        {envText(job.env) ?? t("computeJobs.unknown")}
      </div>
      <div data-testid="computejobs-detail-inputs">
        {t("computeJobs.detail.inputs")}:{" "}
        {job.inputs.length === 0
          ? t("computeJobs.noInput")
          : job.inputs.map((i) => (i.deleted ? t("computeJobs.deletedSeries") : `${i.format}`)).join(", ")}
      </div>
      <div>
        {timeline.map(([k, v]) => `${k} ${v}`).join(" → ")}
        {dur ? ` (${dur})` : ""}
      </div>
      {(job.state === "FAILED" || job.state === "INTERRUPTED") && (
        <div data-testid="computejobs-detail-reason" style={{ color: "#b00020" }}>
          {t("computeJobs.detail.reason")}: {reason ? t(reason) : job.reason ?? t("computeJobs.unknown")}
          {errorDetail(job) ? ` — ${errorDetail(job)}` : ""}
        </div>
      )}
      {cleanup && (
        <div data-testid="computejobs-detail-cleanup">
          {t("computeJobs.detail.cleanup")}: {t(cleanup)}
        </div>
      )}
      {job.state === "DONE" && job.outputsBytes != null && (
        <div>
          {t("computeJobs.detail.outputs")}: {formatBytes(job.outputsBytes)}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        {(["stderr", "traceback", "stdout"] as ComputeLogKind[]).map((k) => (
          <button key={k} data-testid={`computejobs-log-${k}`} disabled={busy} onClick={() => void open(k)} style={{ marginRight: 6 }}>
            {k}
          </button>
        ))}
      </div>
      {log && (
        <pre data-testid="computejobs-log-text" style={logBox}>
          {log.text ? log.text : t("computeJobs.logNone")}
        </pre>
      )}
    </div>
  );
}

const short = (sha: string) => `${sha.slice(0, 8)}…`;

function stateColor(s: ComputeJobView["state"]): string {
  switch (s) {
    case "RUNNING":
      return "#0b5cad";
    case "DONE":
      return "#1a7f37";
    case "FAILED":
    case "INTERRUPTED":
      return "#b00020";
    case "AWAITING_USER":
      return "#8a5a00";
    default:
      return "#445";
  }
}

const page: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100vh", fontSize: 13, color: "#222", background: "#fff" };
const band: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "#f7f9fb", borderBottom: "1px solid #e6eaee", flexWrap: "wrap" };
const chip: React.CSSProperties = { border: "1px solid #d5dce3", borderRadius: 10, padding: "1px 10px", background: "#fff" };
const toolbar: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid #e6eaee" };
const pill: React.CSSProperties = { border: "1px solid #c8d0d8", borderRadius: 12, padding: "2px 12px", background: "#fff", cursor: "pointer" };
const pillOn: React.CSSProperties = { background: "#e8f1fb", borderColor: "#7fb0e0", color: "#0b5cad" };
const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #d5dce3", background: "#fafbfc", position: "sticky", top: 0 };
const tr: React.CSSProperties = { borderBottom: "1px solid #eef1f4" };
const td: React.CSSProperties = { padding: "6px 8px", verticalAlign: "top" };
const barOuter: React.CSSProperties = { display: "flex", alignItems: "center", marginTop: 3, width: 220 };
const barInner: React.CSSProperties = { height: 6, background: "#0b5cad", borderRadius: 3 };
const detail: React.CSSProperties = { borderTop: "2px solid #d5dce3", padding: "8px 12px", maxHeight: "40vh", overflow: "auto", background: "#fafbfc", lineHeight: 1.6 };
const logBox: React.CSSProperties = { margin: "6px 0 0", padding: 8, background: "#111", color: "#eee", maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12 };
