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
  private clientName: string;
  /** 開発ツリーの desktop/mcpCli.js を、発見用ファイルを明示して起動する（実アプリの userData を使わない検査用）。 */
  static fromRepo(endpointFile: string, clientName: string): McpStdio {
    return new McpStdio({ command: process.execPath, args: [path.join(REPO, "desktop", "mcpCli.js")], env: { ...process.env, GRAPHY_MCP_ENDPOINT: endpointFile }, clientName });
  }
  /**
   * @param o.shell Windows の .cmd は shell 経由でないと起動できない（Node 20.12 以降）。command は引用符で包んで渡すこと。
   */
  constructor(private o: { command: string; args: string[]; env: Record<string, string | undefined>; clientName: string; shell?: boolean }) {
    this.clientName = o.clientName;
    this.proc = spawn(o.command, o.args, { env: o.env, shell: o.shell === true });
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
  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<{ isError: boolean; json: unknown; text: string }> {
    const m = await this.request("tools/call", { name, arguments: args }, timeoutMs);
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
  /** 結果をそのまま返す（image content を含む）。 */
  async callRaw(name: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<{ isError: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] }> {
    const m = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const r = m.result as { isError?: boolean; content?: { type: string; text?: string; data?: string; mimeType?: string }[] } | undefined;
    return { isError: !!r?.isError, content: r?.content ?? [] };
  }
  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

