/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { createMcpServer, relayFor } from "./server";

let srv: http.Server | null = null;
afterEach(() => new Promise((r) => (srv ? (srv.close(() => r(null)), srv.closeAllConnections()) : r(null))));

it("initialize → tools/list → tools/call が受け口まで通り、自称名が届く", async () => {
  const seenClient: string[] = [];
  srv = http.createServer((req, res) => {
    seenClient.push(String(req.headers["x-graphy-mcp-client"]));
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/tools") res.end(JSON.stringify({ tools: [{ name: "get_status", description: "状況", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
      else res.end(JSON.stringify({ ok: true, result: { version: "0.5.1", echo: JSON.parse(Buffer.concat(chunks).toString()).tool } }));
    });
  });
  await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", () => r()));
  const ep = { port: (srv.address() as { port: number }).port, token: "c".repeat(64) };

  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(relayFor(() => ep));
  await server.connect(b);
  const client = new Client({ name: "claude-test-client", version: "9" }, { capabilities: {} });
  await client.connect(a);

  const list = await client.listTools();
  expect(list.tools.map((t) => t.name)).toEqual(["get_status"]);
  const call = await client.callTool({ name: "get_status", arguments: {} });
  expect(call.isError).toBeFalsy();
  expect(JSON.parse((call.content as { text: string }[])[0].text)).toEqual({ version: "0.5.1", echo: "get_status" });
  expect(new Set(seenClient)).toEqual(new Set(["claude-test-client"]));
  await client.close();
});

it("アプリが止まっている（発見用ファイルが無い）ときも、一覧は空・呼び出しは isError でクライアントは落ちない", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(relayFor(() => null));
  await server.connect(b);
  const client = new Client({ name: "c", version: "1" }, { capabilities: {} });
  await client.connect(a);
  expect((await client.listTools()).tools).toEqual([]);
  const r = await client.callTool({ name: "get_status", arguments: {} });
  expect(r.isError).toBe(true);
  await client.close();
});

it("最初は止まっていて（同意待ちなど）一覧が空でも、取れるようになったら tools/list_changed を送る。拒否なら送らない", async () => {
  let state: "down" | "ready" | "denied" = "down";
  const srv2 = http.createServer((_req, res) => {
    if (state === "down") return res.destroy();
    if (state === "denied") {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "client-denied" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tools: [{ name: "get_status", inputSchema: { type: "object", properties: {} } }] }));
  });
  await new Promise<void>((r) => srv2.listen(0, "127.0.0.1", () => r()));
  const ep = { port: (srv2.address() as { port: number }).port, token: "d".repeat(64) };
  try {
    for (const final of ["ready", "denied"] as const) {
      state = "down";
      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer(relayFor(() => ep), { retryMs: 30, retryMax: 20 });
      await server.connect(b);
      const client = new Client({ name: "c", version: "1" }, { capabilities: {} });
      let changed = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        changed++;
      });
      await client.connect(a);
      expect((await client.listTools()).tools).toEqual([]);
      state = final;
      await new Promise((r) => setTimeout(r, 400));
      expect(changed).toBe(final === "ready" ? 1 : 0);
      if (final === "ready") expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["get_status"]);
      await client.close();
    }
  } finally {
    srv2.close();
    srv2.closeAllConnections();
  }
});
