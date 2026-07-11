import http from "node:http";

export interface WaitForHttpOptions {
  /** 接続先ホスト名。Vite dev server は既定で localhost(→環境によっては ::1 優先)にバインドされ、
   * 127.0.0.1 では繋がらないことがある（開発中に実際に踏んだ罠）。呼び出し側の対象に合わせて選ぶこと。 */
  host: string;
  port: number;
  path: string;
  timeoutMs: number;
  onAttempt?: (info: { attempt: number; elapsedMs: number; outcome: string }) => void;
}

/** 指定エンドポイントが 5xx 以外を返すまでポーリングする。 */
export function waitForHttp(opts: WaitForHttpOptions): Promise<void> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  let attempt = 0;
  return new Promise((resolve, reject) => {
    const retry = (reason: string) => {
      opts.onAttempt?.({ attempt, elapsedMs: elapsed(), outcome: `retry (${reason})` });
      if (elapsed() > opts.timeoutMs) {
        reject(new Error(`timeout waiting for http://${opts.host}:${opts.port}${opts.path} after ${attempt} attempts`));
        return;
      }
      setTimeout(tick, 500);
    };
    const tick = () => {
      attempt += 1;
      const req = http.get({ host: opts.host, port: opts.port, path: opts.path, timeout: 4000 }, (res) => {
        res.resume();
        opts.onAttempt?.({ attempt, elapsedMs: elapsed(), outcome: `status=${res.statusCode}` });
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry(`status=${res.statusCode}`);
      });
      req.on("error", (err) => retry(`error=${(err as Error).message}`));
      req.on("timeout", () => req.destroy(new Error("request-timeout")));
    };
    tick();
  });
}
