/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelay, MSG_DENIED, MSG_NOT_RUNNING, MSG_TIMEOUT, readEndpointFile, type Endpoint } from "./relay";

const TOKEN = "a".repeat(64);

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => (s.close(() => r(null)), s.closeAllConnections()))));
  servers = [];
});

/** mcpBridge の受け口の形を真似た偽物（実物は desktop/mcpBridge.test.js が検査する）。 */
async function fakeBridge(reply: (seen: Seen) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const one = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(one);
      const r = reply(one);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body === undefined ? "" : JSON.stringify(r.body));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { seen, ep: { port, token: TOKEN } as Endpoint };
}

const relayTo = (ep: Endpoint | null, name = "claude-test") => createRelay({ readEndpoint: () => ep, clientName: () => name, timeoutMs: 3000, callTimeoutMs: 3000 });

describe("relay", () => {
  it("一覧は受け口の tools をそのまま返し、Bearer・自称名を付け、Origin を付けない", async () => {
    const tools = [{ name: "get_status", description: "d", inputSchema: { type: "object", properties: {} } }];
    const { ep, seen } = await fakeBridge(() => ({ status: 200, body: { tools } }));
    expect(await relayTo(ep).listTools()).toEqual(tools);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/v1/tools");
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].headers["x-graphy-mcp-client"]).toBe("claude-test");
    expect(seen[0].headers.origin).toBeUndefined();
    expect(seen[0].headers.host).toBe(`127.0.0.1:${ep.port}`);
  });

  it("呼び出しは { tool, args } を送り、結果を text の content にする", async () => {
    const { ep, seen } = await fakeBridge(() => ({ status: 200, body: { ok: true, result: [{ study: "st_x" }] } }));
    const r = await relayTo(ep).callTool("search_studies", { modality: "CT" });
    expect(JSON.parse(seen[0].body)).toEqual({ tool: "search_studies", args: { modality: "CT" } });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual([{ study: "st_x" }]);
  });

  it("受け口の { ok:false, error } は符号だけの isError にする", async () => {
    const { ep } = await fakeBridge(() => ({ status: 200, body: { ok: false, error: "phi-disabled:patientName" } }));
    const r = await relayTo(ep).callTool("search_studies", { patientName: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("error: phi-disabled:patientName");
  });

  it("符号の形が違う本文（患者情報が入り得る）は返さず、固定文にする", async () => {
    const { ep } = await fakeBridge(() => ({ status: 200, body: { ok: false, error: "山田 太郎 のデータ" } }));
    const r = await relayTo(ep).callTool("get_status", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain("山田");
  });

  it("403 は拒否の文、受け口が 404 なら起動していない旨", async () => {
    const denied = await fakeBridge(() => ({ status: 403, body: { ok: false, error: "client-denied" } }));
    expect((await relayTo(denied.ep).callTool("get_status", {})).content[0].text).toBe(MSG_DENIED);
    const off = await fakeBridge(() => ({ status: 404 }));
    const r = await relayTo(off.ep).callTool("get_status", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(MSG_NOT_RUNNING);
    expect(await relayTo(off.ep).listTools()).toEqual([]);
  });

  it("発見用ファイルが無い・受け口が閉じているときは、例外にせず固定文の isError（一覧は空）", async () => {
    const none = relayTo(null);
    expect(await none.listTools()).toEqual([]);
    expect((await none.callTool("get_status", {})).content[0].text).toBe(MSG_NOT_RUNNING);
    const { ep } = await fakeBridge(() => ({ status: 200, body: {} }));
    await Promise.all(servers.map((s) => new Promise((r) => (s.close(() => r(null)), s.closeAllConnections()))));
    servers = [];
    const closed = relayTo(ep);
    expect(await closed.listTools()).toEqual([]);
    expect((await closed.callTool("get_status", {})).isError).toBe(true);
  });

  it("要求ごとに発見用ファイルを読み直す（トークンが変わった次の要求から新しい値）", async () => {
    const { ep, seen } = await fakeBridge(() => ({ status: 200, body: { tools: [] } }));
    let cur: Endpoint = ep;
    const relay = createRelay({ readEndpoint: () => cur, clientName: () => "c", timeoutMs: 3000 });
    await relay.listTools();
    cur = { ...ep, token: "b".repeat(64) };
    await relay.listTools();
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${"b".repeat(64)}`]);
  });

  it("呼び出しは、アプリが利用者の確認を待つ間（応答が遅い間）も待つ。一覧の待ち時間とは別（確認の待ちで「起動していない」と誤報しない）", async () => {
    let slow = 250;
    const s = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url === "/v1/tools" ? { tools: [] } : { ok: true, result: { done: true } }));
      }, slow));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const ep = { port: (s.address() as { port: number }).port, token: TOKEN } as Endpoint;
    // 一覧は 100ms、呼び出しは 2000ms まで待つ。応答は 250ms かかる
    const relay = createRelay({ readEndpoint: () => ep, clientName: () => "c", timeoutMs: 100, callTimeoutMs: 2000 });
    const call = await relay.callTool("create_roi", {});
    expect(call.isError).toBeUndefined();
    expect(JSON.parse(call.content[0].text)).toEqual({ done: true });
    expect(await relay.listTools()).toEqual([]); // 一覧は 100ms で切れる（空で返る。例外にしない）
    // 呼び出しの待ち時間が切れたら、受け口が無い（起動していない）のとは別の文面
    slow = 1500;
    const quick = createRelay({ readEndpoint: () => ep, clientName: () => "c", callTimeoutMs: 150 });
    const t = await quick.callTool("create_roi", {});
    expect(t.isError).toBe(true);
    expect(t.content[0].text).toBe(MSG_TIMEOUT);
    expect(t.content[0].text).not.toBe(MSG_NOT_RUNNING);
  });

  it("自称名は 64 字に切り、制御文字を空白にする", async () => {
    const { ep, seen } = await fakeBridge(() => ({ status: 200, body: { tools: [] } }));
    await relayTo(ep, `x\r\ny${"z".repeat(100)}`).listTools();
    const got = String(seen[0].headers["x-graphy-mcp-client"]);
    expect(got.length).toBeLessThanOrEqual(64);
    expect(got).not.toMatch(/[\r\n]/);
  });
});

describe("readEndpointFile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ep-"));
  const f = path.join(dir, "mcp-endpoint.json");
  afterEach(() => fs.rmSync(f, { force: true }));

  it("正しい形は読み、無い・壊れている・形が違うものは null", () => {
    expect(readEndpointFile(f)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ port: 5123, token: TOKEN }));
    expect(readEndpointFile(f)).toEqual({ port: 5123, token: TOKEN });
    for (const bad of ["{bad", JSON.stringify({ port: 0, token: TOKEN }), JSON.stringify({ port: 70000, token: TOKEN }), JSON.stringify({ port: 5123, token: "短い" }), JSON.stringify({ port: "5123", token: TOKEN })]) {
      fs.writeFileSync(f, bad);
      expect(readEndpointFile(f)).toBeNull();
    }
  });
});
