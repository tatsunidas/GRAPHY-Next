/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 外部 AI クライアント（Claude Desktop など）と起動中の GRAPHY-Next の受け口（desktop/mcpBridge.js）をつなぐ中継の本体。
// 設計: roadmap fw/mcp-server-design.md §2・§4。🔴 ここは判断を持たない。一覧も呼び出しも受け口へ転送するだけで、
// 射影・同意・監査・引数の検査・拒否リストはすべて main 側（mcpBridge / mcpTools / mcpProjection）にある。
// 🔴 stderr は MCP クライアントのログに残る。引数・結果・受け口の本文は書かず、固定の文だけにする（呼び出し側 server.ts も同じ）。
// 🔴 発見用ファイル（userData/mcp-endpoint.json）のトークンは起動ごとに変わるので、要求ごとに読み直す。
import fs from "node:fs";
import http from "node:http";

export interface Endpoint {
  port: number;
  token: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface RelayDeps {
  /** 受け口の場所。無ければ null（アプリが止まっている・MCP がオフ）。 */
  readEndpoint: () => Endpoint | null;
  /** MCP の initialize で相手が名乗った名前（確認できない自己申告）。 */
  clientName: () => string;
  timeoutMs?: number;
}

export const MSG_NOT_RUNNING = "GRAPHY-Next が起動していないか、設定で MCP 接続がオフです。アプリを起動し、MCP 接続をオンにしてください。";
export const MSG_DENIED = "GRAPHY-Next 側で接続が拒否されました。アプリを再起動するまで受け付けません。";
const MSG_BUSY = "GRAPHY-Next が処理中です。少し待ってからもう一度呼んでください。";
const MSG_FAILED = "GRAPHY-Next からの応答を処理できませんでした。";

const MAX_RESPONSE = 1024 * 1024;
const TOKEN_RE = /^[0-9a-f]{16,128}$/;
const CODE_RE = /^[A-Za-z0-9:_-]{1,64}$/;

/** mcp-endpoint.json を読む。形が違えば null（無い扱い。本文は返さない）。 */
export function readEndpointFile(file: string): Endpoint | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { port?: unknown; token?: unknown };
    if (typeof j.port !== "number" || !Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null;
    if (typeof j.token !== "string" || !TOKEN_RE.test(j.token)) return null;
    return { port: j.port, token: j.token };
  } catch {
    return null;
  }
}

const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max);

type Reply = { status: number; json: unknown };

/** 受け口へ 127.0.0.1 で直接つなぐ。Origin は送らない（受け口は付いていたら 404）。繋がらなければ null。 */
function send(ep: Endpoint, method: "GET" | "POST", path: string, client: string, body: unknown, timeoutMs: number): Promise<Reply | null> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string | number> = {
      host: `127.0.0.1:${ep.port}`,
      authorization: `Bearer ${ep.token}`,
      "x-graphy-mcp-client": oneLine(client, 64) || "unknown",
    };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    const req = http.request({ host: "127.0.0.1", port: ep.port, method, path, headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (c: Buffer) => {
        n += c.length;
        if (n > MAX_RESPONSE) {
          req.destroy();
          resolve({ status: 0, json: null });
        } else chunks.push(c);
      });
      res.on("end", () => {
        let json: unknown = null;
        try {
          const t = Buffer.concat(chunks).toString("utf8");
          json = t ? JSON.parse(t) : null;
        } catch {
          /* JSON でない本文は使わない */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

const fail = (text: string): CallResult => ({ content: [{ type: "text", text }], isError: true });

/** 直近の一覧の取得の結果。ready＝取れた／denied＝利用者が拒否した（再起動まで変わらない）／down＝止まっている・同意の返事待ちで時間切れ。 */
export type ListState = "ready" | "denied" | "down";

export function createRelay(deps: RelayDeps) {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  let listState: ListState = "down";

  async function listTools(): Promise<ToolDef[]> {
    const ep = deps.readEndpoint();
    if (!ep) {
      listState = "down";
      return [];
    }
    const r = await send(ep, "GET", "/v1/tools", deps.clientName(), undefined, timeoutMs);
    const tools = r && r.status === 200 && r.json && typeof r.json === "object" ? (r.json as { tools?: unknown }).tools : null;
    listState = Array.isArray(tools) ? "ready" : r && r.status === 403 ? "denied" : "down";
    // 一覧が取れないときは空（クライアントを落とさない）。呼び出しのほうで理由を返す。
    return Array.isArray(tools) ? (tools as ToolDef[]) : [];
  }

  async function callTool(name: string, args: unknown): Promise<CallResult> {
    const ep = deps.readEndpoint();
    if (!ep) return fail(MSG_NOT_RUNNING);
    const r = await send(ep, "POST", "/v1/call", deps.clientName(), { tool: name, args }, timeoutMs);
    if (!r || r.status === 404) return fail(MSG_NOT_RUNNING);
    if (r.status === 403) return fail(MSG_DENIED);
    if (r.status === 429) return fail(MSG_BUSY);
    const j = r.json as { ok?: unknown; result?: unknown; error?: unknown } | null;
    if (r.status === 200 && j && j.ok === true) return { content: [{ type: "text", text: JSON.stringify(j.result) }] };
    // 受け口の符号（例 `phi-disabled:patientName`）だけを返す。形が違えば固定文。
    const code = j && typeof j.error === "string" && CODE_RE.test(j.error) ? j.error : null;
    return fail(code ? `error: ${code}` : MSG_FAILED);
  }

  return { listTools, callTool, listState: () => listState };
}

export type Relay = ReturnType<typeof createRelay>;
