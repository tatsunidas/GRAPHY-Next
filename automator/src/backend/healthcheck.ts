import { waitForHttp } from "../common/waitForHttp.js";

export function waitForBackendReady(httpPort: number, timeoutMs = 60_000): Promise<void> {
  return waitForHttp({
    host: "127.0.0.1",
    port: httpPort,
    path: "/api/status",
    timeoutMs,
  });
}
