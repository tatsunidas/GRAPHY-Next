/*
 * 中継（desktop/mcpCli.js）を実際に spawn して話す、検査用の最小の MCP クライアント（改行区切りの JSON-RPC 2.0、stdio）。
 * 公式 SDK に依存せず、配布物の stdio プロトコルをそのまま叩く（installedSmoke.ts の mcpSection も同じ形）。
 */
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const REPO = path.join(import.meta.dirname, "..", "..", "..");

export class McpStdio {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private id = 0;
  private waiting = new Map<number, (m: Record<string, unknown>) => void>();
  stderr = "";
  constructor(endpointFile: string, private clientName: string) {
    this.proc = spawn(process.execPath, [path.join(REPO, "desktop", "mcpCli.js")], { env: { ...process.env, GRAPHY_MCP_ENDPOINT: endpointFile } });
    this.proc.stdout.on("data", (c: Buffer) => {
      this.buf += c.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as Record<string, unknown>;
        const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
        if (w) {
          this.waiting.delete(m.id as number);
          w(m);
        }
      }
    });
    this.proc.stderr.on("data", (c: Buffer) => (this.stderr += c.toString("utf8")));
  }
  private send(o: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(o)}\n`);
  }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
      this.waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: this.clientName, version: "1" } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; json: unknown; text: string }> {
    const m = await this.request("tools/call", { name, arguments: args });
    const r = m.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
    const text = r?.content?.[0]?.text ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 文面 */
    }
    return { isError: !!r?.isError, json, text };
  }
  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

