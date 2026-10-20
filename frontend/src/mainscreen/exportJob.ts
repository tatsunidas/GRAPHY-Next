// エクスポートジョブ（進捗と中止）。画面から切り離した純ロジック。importJob.ts と同じ形。
import type { ExportJobStatus } from "../api";

/** ジョブ状態のうち、進捗の問い合わせに要る最小の形（エクスポートも匿名化ジョブも満たす）。 */
export interface JobProgress {
  jobId: string;
  state: string;
  total: number;
  processed: number;
}

const FINISHED = ["DONE", "FAILED", "CANCELLED"];

export const isExportFinished = (s: JobProgress) => FINISHED.includes(s.state);

/** 進捗バーの割合（0〜100）。総数が分かるまでは null（不定バー）。 */
export function exportPercent(s: JobProgress): number | null {
  if (s.state === "QUEUED" || s.total <= 0) return null;
  return Math.min(100, Math.floor((s.processed / s.total) * 100));
}

export interface ExportJobApi<S extends JobProgress = ExportJobStatus> {
  submit: () => Promise<S>;
  get: (jobId: string) => Promise<S>;
  cancel: (jobId: string) => Promise<unknown>;
}

/**
 * 投入して終わるまで問い合わせる。`shouldCancel()` が真になったら中止を 1 回だけ送り、その後も
 * サーバーが止まって出力を片付けるまで問い合わせを続ける。
 */
export async function runExportJob<S extends JobProgress = ExportJobStatus>(
  api: ExportJobApi<S>,
  onStatus: (s: S) => void,
  shouldCancel: () => boolean,
  intervalMs = 500,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<S> {
  let cur = await api.submit();
  onStatus(cur);
  let cancelSent = false;
  while (!isExportFinished(cur)) {
    await sleep(intervalMs);
    if (!cancelSent && shouldCancel()) {
      cancelSent = true;
      await api.cancel(cur.jobId);
    }
    cur = await api.get(cur.jobId);
    onStatus(cur);
  }
  return cur;
}
