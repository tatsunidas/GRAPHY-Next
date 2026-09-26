/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * どの画面のプラグインにも渡す host API（H43〜H46）。
 *
 * <ul>
 *   <li>H43 `file.pickFiles` … OS の「開く」ダイアログ（ファイルだけ）</li>
 *   <li>H44 `db.searchPatients` … 患者の検索（読み取りのみ）</li>
 *   <li>H45 `runBackendJob` … バックエンド面をジョブとして走らせる（進捗・取り消し）</li>
 *   <li>H46 `db.notifyChanged` … DB を変えたことを本体の一覧へ知らせる</li>
 * </ul>
 * 設計: `fw/plugin-architecture.md`（host API の表）。
 */
import { desktop, type PickFilesResult } from "../desktopBridge";
import { emitDbChanged } from "../dbEvents";
import { httpGet, httpSend } from "../http";
import { log } from "../log";

export type { PickFilesResult };

export interface PluginPickFilesOptions {
  /** ダイアログの題。 */
  title?: string;
  /** 複数選べるか（既定 false）。 */
  multiple?: boolean;
  /** 拡張子のフィルタ（例 `[{ name: "Video", extensions: ["avi", "mp4"] }]`）。 */
  filters?: { name: string; extensions: string[] }[];
}

/**
 * 開くダイアログでファイルを選ばせ、絶対パスを返す（H43）。
 *
 * <p>デスクトップ専用（web では `error: "desktop-only"`）。**フォルダは選べない**。
 * 取り消しは `canceled: true`（失敗ではないのでエラー表示をしないこと）。
 */
export async function pickFiles(opts: PluginPickFilesOptions = {}): Promise<PickFilesResult> {
  const d = desktop();
  if (!d?.pickFiles) return { ok: false, error: "desktop-only" };
  const r = await d.pickFiles({ title: opts.title, multiple: !!opts.multiple, filters: opts.filters });
  if (r.ok) log.info(`[plugin] pickFiles: ${r.paths.length} file(s)`);
  return r;
}

/** 患者の検索結果（H44）。`patientKey` は本体の保存領域・ROI 等で使う同一患者の鍵。 */
export interface PluginPatient {
  patientKey: string;
  patientId: string;
  patientName: string;
  /** DICOM の日付（YYYYMMDD）。無ければ空。 */
  birthDate: string;
  sex: string;
  studyCount: number;
}

interface PatientDto {
  patientId: string | null;
  patientName: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  numberOfStudies: number;
}

/**
 * 患者を ID・氏名の部分一致で探す（H44・読み取りのみ）。
 *
 * <p>`patientKey` は `patientId || patientName`（2D ビューアの同一患者判定と同じ規則。
 * どちらも無い患者は検索で引けないので、スタディ UID の枝は要らない）。
 */
export async function searchPatients(query: string): Promise<PluginPatient[]> {
  const q = query.trim();
  const list = await httpGet<PatientDto[]>(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  return (Array.isArray(list) ? list : [])
    .map((p) => ({
      patientKey: p.patientId || p.patientName || "",
      patientId: p.patientId ?? "",
      patientName: p.patientName ?? "",
      birthDate: p.patientBirthDate ?? "",
      sex: p.patientSex ?? "",
      studyCount: Number(p.numberOfStudies) || 0,
    }))
    .filter((p) => p.patientKey !== "");
}

/**
 * DB を変えたことを知らせる（H46）。本体のメイン画面の一覧（同じウィンドウも含む）と、
 * 開いている他のウィンドウ（2D ビューア等）が読み直す。
 */
export function notifyDbChanged(pluginId: string, detail: { studyUids?: string[]; patientId?: string } = {}): void {
  emitDbChanged({ reason: `plugin:${pluginId}`, ...detail }, { includeSelf: true });
}

/** ジョブの状態（backend の `PluginJobService.Status`）。 */
export interface PluginJobStatus {
  jobId: string;
  state: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  progress: number;
  message: string;
  elapsedMs: number;
  result: unknown;
  error: string | null;
}

export interface PluginJobOptions {
  /** 進み具合（0〜1）と短い説明。ポーリングのたびに呼ばれる。 */
  onProgress?: (progress: number, message: string) => void;
  /** 取り消し。abort すると backend に取り消しを求め、プラグインが止まるのを待つ。 */
  signal?: AbortSignal;
  /** ポーリング間隔（ms・既定 400）。 */
  pollMs?: number;
}

/**
 * ジョブの結果。**例外は投げない**（`ai.generate` と同じ流儀）。
 * `cancelled: true` は利用者の取り消しで、エラーとして表示しないこと。
 */
export type PluginJobOutcome =
  | { ok: true; result: unknown }
  | { ok: false; cancelled?: boolean; error?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * バックエンド面をジョブとして走らせる（H45）。
 *
 * <p>プラグインの JAR には、args の `__progress`（`BiConsumer<Double,String>`）と
 * `__cancelled`（`BooleanSupplier`）が渡る。同期の `runBackend` と同じ `run(Map)` が呼ばれるので、
 * JAR はどちらの経路でも動くように「無ければ何もしない」で書くこと。
 */
export async function runBackendJob(
  pluginId: string,
  payload: unknown,
  opts: PluginJobOptions = {},
): Promise<PluginJobOutcome> {
  let started: PluginJobStatus;
  try {
    started = await httpSend<PluginJobStatus>(`/api/plugins/${encodeURIComponent(pluginId)}/jobs`, "POST", payload ?? {});
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const url = `/api/plugin-jobs/${encodeURIComponent(started.jobId)}`;
  let cancelSent = false;
  const pollMs = Math.max(100, opts.pollMs ?? 400);
  for (;;) {
    if (opts.signal?.aborted && !cancelSent) {
      cancelSent = true;
      await httpSend(url, "DELETE").catch(() => undefined);
    }
    let st: PluginJobStatus;
    try {
      st = await httpGet<PluginJobStatus>(url);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      opts.onProgress?.(st.progress, st.message);
    } catch (e) {
      log.warn("[plugin] onProgress threw", e);
    }
    if (st.state === "DONE") return { ok: true, result: st.result };
    if (st.state === "CANCELLED") return { ok: false, cancelled: true };
    if (st.state === "FAILED") return { ok: false, error: st.error ?? "failed" };
    await sleep(pollMs);
  }
}
