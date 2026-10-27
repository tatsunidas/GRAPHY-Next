/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveRoiDocument } from "./roiPersistenceApi";

const dto = { patientKey: "P", json: "{}", roiCount: 0, updatedAt: "now", version: 1 };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(dto), { status: 200, headers: { "content-type": "application/json" } })));
  vi.stubGlobal("fetch", fetchMock);
  // テストは node 環境。`apiBase()` が参照する window だけを空で用意する（API の基点は未設定＝空）。
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("saveRoiDocument の keepalive（閉じる直前の送信）", () => {
  it("keepalive 指定で本体が小さければ、keepalive の PUT を直に送る", async () => {
    const out = await saveRoiDocument("D97258/11053", "{\"rois\":[]}", 0, 3, true);
    expect(out.version).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/rois?patientKey=D97258%2F11053");
    expect(init.method).toBe("PUT");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body)).toEqual({ json: "{\"rois\":[]}", roiCount: 0, version: 3 });
  });

  it("本体が大きいと keepalive を付けない（付けると要求ごと失敗する）", async () => {
    await saveRoiDocument("P", "x".repeat(70_000), 0, null, true);
    expect(fetchMock.mock.calls[0][1].keepalive).toBeFalsy();
  });

  it("keepalive 指定なしでは付けない", async () => {
    await saveRoiDocument("P", "{}", 0, null);
    expect(fetchMock.mock.calls[0][1].keepalive).toBeFalsy();
  });

  it("失敗（409 など）は HttpError にして握り潰さない", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "版が古いです" }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(saveRoiDocument("P", "{}", 0, 1, true)).rejects.toMatchObject({ status: 409, message: "版が古いです" });
  });
});
