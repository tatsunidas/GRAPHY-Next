/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// graphy-mcp（stdio）の入口。`scripts/build-mcp.mjs` が `desktop/mcp/run.cjs` に束ね、desktop/mcpCli.js が呼ぶ。
// 🔴 SDK は stdio だけに使う（HTTP のトランスポート・OAuth は束ねない。ビルドが検査する）。判断は relay.ts にも無い。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRelay, readEndpointFile, type Endpoint, type Relay } from "./relay";

export interface ServerOpts {
  /** 一覧が取れなかったとき、取れるまで再試行する間隔（ms）。 */
  retryMs?: number;
  /** 再試行の回数の上限。 */
  retryMax?: number;
}

/**
 * relay を MCP のサーバーにする。`clientName` は initialize で相手が名乗った名前（テストから差し込める）。
 * 最初の接続では main が同意を求めるので、利用者が答える前に一覧の要求が時間切れになる（クライアントは最初に tools/list を呼ぶ）。
 * 空の一覧を返したままにしないよう、止まっている間は再試行し、取れたら tools/list_changed を送る。拒否（denied）なら再試行しない。
 */
export function createMcpServer(make: (clientName: () => string) => Relay, opts: ServerOpts = {}): Server {
  const server = new Server({ name: "graphy-mcp", version: "1" }, { capabilities: { tools: { listChanged: true } } });
  const relay = make(() => server.getClientVersion()?.name ?? "unknown");
  const retryMs = opts.retryMs ?? 5000;
  const retryMax = opts.retryMax ?? 120;
  let closed = false;
  let watching = false;
  server.onclose = () => {
    closed = true;
  };

  async function watch() {
    if (watching) return;
    watching = true;
    try {
      for (let i = 0; i < retryMax && !closed; i++) {
        await new Promise<void>((r) => setTimeout(r, retryMs).unref());
        if (closed) return;
        const tools = await relay.listTools();
        if (relay.listState() === "denied") return;
        if (tools.length) {
          await server.sendToolListChanged();
          return;
        }
      }
    } catch {
      /* 通知できなければ終わる（クライアントが閉じた） */
    } finally {
      watching = false;
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await relay.listTools();
    if (relay.listState() === "down") void watch();
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await relay.callTool(req.params.name, req.params.arguments ?? {});
    return r.isError ? { content: r.content, isError: true } : { content: r.content };
  });
  return server;
}

export function relayFor(readEndpoint: () => Endpoint | null) {
  return (clientName: () => string) => createRelay({ readEndpoint, clientName });
}

/** `desktop/mcpCli.js` から。stdin が閉じるまで動く。stderr には固定の文だけ。 */
export async function runMcp(endpointFile: string): Promise<number> {
  const server = createMcpServer(relayFor(() => readEndpointFile(endpointFile)));
  const done = new Promise<void>((resolve) => {
    const prev = server.onclose;
    server.onclose = () => {
      prev?.();
      resolve();
    };
  });
  await server.connect(new StdioServerTransport());
  await done;
  return 0;
}
