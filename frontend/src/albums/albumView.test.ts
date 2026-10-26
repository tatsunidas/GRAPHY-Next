/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const httpGet = vi.fn();
vi.mock("../http", async (orig) => ({
  ...(await orig<typeof import("../http")>()),
  httpGet: (...a: unknown[]) => httpGet(...a),
}));

import { fetchStudies } from "../api";
import { chunkUids } from "./albumApi";
import { EMPTY_ALBUM_UID, albumFilters, missingUids } from "./albumView";

const study = (uid: string) => ({ studyInstanceUid: uid });

describe("アルバムの一覧の条件", () => {
  it("UID をカンマで並べ、重複と空は除く", () => {
    expect(albumFilters(["1.2", "1.3", "1.2", ""])).toEqual({ studyInstanceUid: "1.2,1.3" });
  });

  it("空のアルバムは何も当たらない UID にする（空文字だと条件ごと捨てられて全件が出る）", () => {
    expect(albumFilters([])).toEqual({ studyInstanceUid: EMPTY_ALBUM_UID });
    expect(albumFilters([""]).studyInstanceUid).toBe(EMPTY_ALBUM_UID);
    expect(EMPTY_ALBUM_UID).not.toBe("");
  });
});

describe("見つかりません（アルバムにあるのに一覧に無い UID）", () => {
  it("出てこなかった UID だけを、アルバムの並びで返す", () => {
    expect(missingUids(["1.1", "1.2", "1.3"], [study("1.2")])).toEqual(["1.1", "1.3"]);
  });
  it("負例: 全部あれば空。重複する UID は 1 回", () => {
    expect(missingUids(["1.1", "1.2"], [study("1.1"), study("1.2"), study("9.9")])).toEqual([]);
    expect(missingUids(["1.1", "1.1"], [])).toEqual(["1.1"]);
  });
});

describe("API の 1 回あたりの件数", () => {
  it("1000 件ごとに分ける", () => {
    const uids = Array.from({ length: 2500 }, (_, i) => `1.${i}`);
    expect(chunkUids(uids).map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunkUids([])).toEqual([]);
  });
});

describe("fetchStudies の UID 指定の分割", () => {
  beforeEach(() => httpGet.mockReset());

  // 長い UID を並べて URL に収まらない長さにする（chunkForQuery の既定は 3000 字）
  const uid = (i: number) => `1.2.826.0.1.3680043.8.498.${String(i).padStart(30, "0")}`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => uid(i));
  const reply = (url: string) => {
    const q = new URL(url, "http://x").searchParams.get("studyInstanceUid") ?? "";
    return Promise.resolve(q.split(",").filter(Boolean).map(study));
  };

  it("短ければ今までと同じ 1 リクエスト", async () => {
    httpGet.mockImplementation(reply);
    const r = await fetchStudies({ studyInstanceUid: many(3).join(",") });
    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(r).toHaveLength(3);
  });

  it("UID 指定が無い検索は 1 リクエストのまま", async () => {
    httpGet.mockResolvedValue([]);
    await fetchStudies({ patientId: "P1" });
    await fetchStudies();
    expect(httpGet).toHaveBeenCalledTimes(2);
    expect(httpGet.mock.calls[0][0]).toBe("/api/studies?patientId=P1");
  });

  it("長ければ分けて取り、全部を重複なしで結合する", async () => {
    httpGet.mockImplementation(reply);
    const uids = many(200);
    const r = await fetchStudies({ studyInstanceUid: uids.join(",") });
    expect(httpGet.mock.calls.length).toBeGreaterThan(1);
    for (const c of httpGet.mock.calls) expect(String(c[0]).length).toBeLessThan(4000);
    expect(r.map((s) => s.studyInstanceUid).sort()).toEqual([...uids].sort());
  });

  it("別のかたまりに同じスタディが返っても 1 件", async () => {
    httpGet.mockImplementation(() => Promise.resolve([study("dup")]));
    const r = await fetchStudies({ studyInstanceUid: many(200).join(",") });
    expect(r).toEqual([study("dup")]);
  });

  it("1 つでも失敗したら全体が失敗（一部だけ出さない）", async () => {
    let n = 0;
    httpGet.mockImplementation((url: string) => (++n === 2 ? Promise.reject(new Error("boom")) : reply(url)));
    await expect(fetchStudies({ studyInstanceUid: many(200).join(",") })).rejects.toThrow("boom");
  });
});
