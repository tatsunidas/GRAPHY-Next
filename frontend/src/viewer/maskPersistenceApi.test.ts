/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveMask } from "./maskPersistenceApi";

const summary = { maskUid: "m", seriesUid: "s", meta: "{}", frameCount: 1, bytes: 1, version: 0, updatedAt: null };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(summary), { status: 200, headers: { "content-type": "application/json" } })));
  vi.stubGlobal("fetch", fetchMock);
  // テストは node 環境。`apiBase()` が参照する window だけを空で用意する（API の基点は未設定＝空）。
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

const args = (frames: number, meta = "{}") => ({
  patientKey: "D97258/11053", seriesUid: "s", frameCount: 1, version: null as number | null, meta, frames: new Uint8Array(frames),
});

describe("saveMask の keepalive（閉じる直前の送信）", () => {
  it("本体（画素＋メタ）が 60 KB 以下なら keepalive を付ける", async () => {
    await saveMask("m", args(59_000));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("patientKey=D97258%2F11053");
    expect(init.method).toBe("PUT");
    expect(init.keepalive).toBe(true);
  });

  it("画素＋メタが上限を超えると付けない（境界: 60,000 は付き、60,001 は付かない）", async () => {
    await saveMask("m", args(59_990, "x".repeat(10)));
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    await saveMask("m", args(59_990, "x".repeat(11)));
    expect(fetchMock.mock.calls[1][1].keepalive).toBe(false);
  });

  it("失敗（409・413）は status 付きの HttpError にする", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "大きすぎます" }), { status: 413, headers: { "content-type": "application/json" } }));
    await expect(saveMask("m", args(10))).rejects.toMatchObject({ status: 413 });
  });
});
