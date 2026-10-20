import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginCache, validCacheKey } from "./pluginCacheApi";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", {}); // apiBase() が window を読む（テストは node 環境）
});
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bytes = (b: number[]) => new Response(new Uint8Array(b), { status: 200, headers: { "Content-Type": "application/octet-stream" } });

describe("H69 host.cache", () => {
  it("put: URL はプラグイン id に固定され、鍵はヘッダ（URL に載せない）、本体はバイナリ", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    const r = await createPluginCache("my/plugin").put("再構成 A+B/1", new Uint8Array([1, 2, 3]));
    expect(r).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/plugins\/my%2Fplugin\/cache\/item$/);
    expect(url).not.toContain("A+B");
    expect(init.method).toBe("PUT");
    expect(init.headers["X-Plugin-Cache-Key"]).toBe(encodeURIComponent("再構成 A+B/1"));
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(Array.from(init.body as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("get: 無い（404）・通信失敗は null（例外にしない）。あればバイト列", async () => {
    const c = createPluginCache("p");
    fetchMock.mockResolvedValueOnce(bytes([9, 8]));
    expect(Array.from((await c.get("k"))!)).toEqual([9, 8]);
    fetchMock.mockResolvedValueOnce(json(404, { error: "not-found" }));
    expect(await c.get("k")).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await c.get("k")).toBeNull();
  });

  it("put の失敗は理由コードの値: too-large(413)・write-failed(500)・通信失敗は network", async () => {
    const c = createPluginCache("p");
    fetchMock.mockResolvedValueOnce(json(413, { error: "too-large" }));
    expect(await c.put("k", new Uint8Array(1))).toEqual({ ok: false, error: "too-large" });
    fetchMock.mockResolvedValueOnce(json(500, { error: "write-failed" }));
    expect(await c.put("k", new Uint8Array(1))).toEqual({ ok: false, error: "write-failed" });
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await c.put("k", new Uint8Array(1))).toEqual({ ok: false, error: "network" });
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 502 }));
    expect(await c.put("k", new Uint8Array(1))).toEqual({ ok: false, error: "http-502" });
  });

  it("不正な鍵は送らずに invalid-key（負例）。長さ 256 はちょうど通る", async () => {
    const c = createPluginCache("p");
    expect(await c.put("", new Uint8Array(1))).toEqual({ ok: false, error: "invalid-key" });
    expect(await c.put("x".repeat(257), new Uint8Array(1))).toEqual({ ok: false, error: "invalid-key" });
    expect(await c.put("a\nb", new Uint8Array(1))).toEqual({ ok: false, error: "invalid-key" });
    expect(await c.get("")).toBeNull();
    expect(await c.has("")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(validCacheKey("x".repeat(256))).toBe(true);
    expect(validCacheKey(42)).toBe(false);
  });

  it("画面から送る大きさの上限（32 MiB）を超えたら、送らずに too-large（画面を守る）", async () => {
    const c = createPluginCache("p");
    expect(await c.put("k", new Uint8Array(32 * 1024 * 1024 + 1))).toEqual({ ok: false, error: "too-large" });
    expect(await c.checkpoint("j").save(0, new Uint8Array(32 * 1024 * 1024 + 1))).toEqual({ ok: false, error: "too-large" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await c.put("k", new Uint8Array(32 * 1024 * 1024))).toEqual({ ok: true });
  });

  it("has は HEAD、remove は DELETE", async () => {
    const c = createPluginCache("p");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await c.has("k")).toBe(true);
    expect(fetchMock.mock.calls[0][1].method).toBe("HEAD");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await c.has("k")).toBe(false);
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await c.remove("k");
    expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
  });

  it("checkpoint: 添字つきの URL・jobKey はヘッダ・clear は添字なしの DELETE、範囲外の添字は送らない", async () => {
    const cp = createPluginCache("p").checkpoint("job-1");
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await cp.save(7, new Uint8Array([5]))).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/cache\/checkpoint\/7$/);
    expect(fetchMock.mock.calls[0][1].headers["X-Plugin-Cache-Key"]).toBe("job-1");
    fetchMock.mockResolvedValueOnce(bytes([5]));
    expect(Array.from((await cp.load(7))!)).toEqual([5]);
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await cp.clear();
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/cache\/checkpoint$/);
    expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");

    const before = fetchMock.mock.calls.length;
    expect(await cp.save(-1, new Uint8Array(1))).toEqual({ ok: false, error: "invalid-index" });
    expect(await cp.save(1_000_000, new Uint8Array(1))).toEqual({ ok: false, error: "invalid-index" });
    expect(await cp.save(1.5, new Uint8Array(1))).toEqual({ ok: false, error: "invalid-index" });
    expect(await cp.load(-1)).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});
