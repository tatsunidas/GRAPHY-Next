// フォルダ・ファイル・ZIP の取り込みジョブ（進捗と中止）。画面から切り離した純ロジック。
import type { ImportJobStatus } from "../api";

export const FINISHED_STATES = ["DONE", "FAILED", "CANCELLED"] as const;

export const isFinished = (s: ImportJobStatus) => (FINISHED_STATES as readonly string[]).includes(s.state);

/** 進捗バーの割合（0〜100）。総数が分からない間は null（不定バー）。処理数が総数を超えても 100 で止める。 */
export function progressPercent(s: ImportJobStatus): number | null {
  if (s.state === "QUEUED" || s.state === "SCANNING" || s.total <= 0) return null;
  return Math.min(100, Math.floor((s.processed / s.total) * 100));
}

export interface ImportJobApi {
  submit: (paths: string[]) => Promise<ImportJobStatus>;
  get: (jobId: string) => Promise<ImportJobStatus>;
  cancel: (jobId: string) => Promise<unknown>;
}

/**
 * 投入して終わるまで問い合わせる。`shouldCancel()` が真になったら中止を 1 回だけ送り、その後も
 * サーバーが止まって結果を返すまで問い合わせを続ける（取り込み済みの件数を取りこぼさない）。
 */
export async function runImportJob(
  api: ImportJobApi,
  paths: string[],
  onStatus: (s: ImportJobStatus) => void,
  shouldCancel: () => boolean,
  intervalMs = 500,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ImportJobStatus> {
  let cur = await api.submit(paths);
  onStatus(cur);
  let cancelSent = false;
  while (!isFinished(cur)) {
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
