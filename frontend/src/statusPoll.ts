/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * 成功するまで `intervalMs` ごとに取り直す。backend の起動が待ちの上限を超えて窓が先に開いたときや、
 * web 版でサーバーを再起動したときに、Reload しなくてもつながるようにする。
 * @returns 止める関数
 */
export function pollStatus<T>(
  fetchFn: () => Promise<T>,
  opts: { onOk: (v: T, afterError: boolean) => void; onError: (e: unknown) => void; intervalMs: number },
): () => void {
  let stopped = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    fetchFn().then(
      (v) => {
        if (stopped) return;
        opts.onOk(v, failed);
      },
      (e: unknown) => {
        if (stopped) return;
        failed = true;
        opts.onError(e);
        timer = setTimeout(attempt, opts.intervalMs);
      },
    );
  };
  attempt();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
