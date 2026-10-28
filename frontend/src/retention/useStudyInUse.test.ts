/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { diffUids, gateUids, studyUidsOfCtx, studyUidsOfTiles } from "./useStudyInUse";

describe("useStudyInUse の純関数", () => {
  it("差分は追加と削除に分かれる", () => {
    expect(diffUids(new Set(["a", "b"]), new Set(["b", "c"]))).toEqual({ add: ["c"], remove: ["a"] });
    expect(diffUids(new Set(), new Set())).toEqual({ add: [], remove: [] });
  });

  it("タイルのスタディは重複なく集め、連結して開いたものは全部分を含める", () => {
    const uids = studyUidsOfTiles([
      { study: { studyInstanceUid: "s1" } },
      { study: { studyInstanceUid: "s1" } },
      { study: { studyInstanceUid: "s2" }, concat: { parts: [{ study: { studyInstanceUid: "s2" } }, { study: { studyInstanceUid: "s3" } }] } },
    ]);
    expect(uids.sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("起動コンテキストからスタディを取り出す。壊れた値・空は空配列", () => {
    expect(studyUidsOfCtx(JSON.stringify({ study: { studyInstanceUid: "s1" } }))).toEqual(["s1"]);
    expect(
      studyUidsOfCtx(JSON.stringify({ study: { studyInstanceUid: "s1" }, concat: { parts: [{ study: { studyInstanceUid: "s9" } }] } })).sort(),
    ).toEqual(["s1", "s9"]);
    expect(studyUidsOfCtx("{not json")).toEqual([]);
    expect(studyUidsOfCtx(null)).toEqual([]);
    expect(studyUidsOfCtx("{}")).toEqual([]);
  });

  it("standalone だと分かるまで・web では、何も知らせない（空にする）", () => {
    expect(gateUids(["s1", "s2"], true)).toEqual(["s1", "s2"]);
    expect(gateUids(["s1", "s2"], false)).toEqual([]);
    expect(gateUids([], false)).toEqual([]);
  });
});
