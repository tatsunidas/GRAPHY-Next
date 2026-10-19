// エクスポートジョブ（進捗と中止）。画面から切り離した純ロジック。importJob.ts と同じ形。
import type { ExportJobStatus } from "../api";

const FINISHED = ["DONE", "FAILED", "CANCELLED"];

export const isExportFinished = (s: ExportJobStatus) => FINISHED.includes(s.state);

/** 進捗バーの割合（0〜100）。総数が分かるまでは null（不定バー）。 */
export function exportPercent(s: ExportJobStatus): number | null {
  if (s.state === "QUEUED" || s.total <= 0) return null;
  return Math.min(100, Math.floor((s.processed / s.total) * 100));
}

export interface ExportJobApi {
  submit: () => Promise<ExportJobStatus>;
  get: (jobId: string) => Promise<ExportJobStatus>;
  cancel: (jobId: string) => Promise<unknown>;
}

/**
 * 投入して終わるまで問い合わせる。`shouldCancel()` が真になったら中止を 1 回だけ送り、その後も
 * サーバーが止まって出力を片付けるまで問い合わせを続ける。
 */
export async function runExportJob(
  api: ExportJobApi,
  onStatus: (s: ExportJobStatus) => void,
  shouldCancel: () => boolean,
  intervalMs = 500,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ExportJobStatus> {
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
