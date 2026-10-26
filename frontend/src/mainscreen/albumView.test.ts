import { describe, expect, it } from "vitest";
import { albumView, missingUids, NO_MATCH_STUDY_UID } from "./albumView";
import { ALBUM_UIDS_PER_REQUEST, splitUids } from "./albumApi";

describe("albumView", () => {
  it("メンバーを 1 つの StudyInstanceUID 指定にする（重複・空は除く）", () => {
    const v = albumView({ id: 3, name: "研究A" }, ["1.2.a", "1.2.b", "1.2.a", ""]);
    expect(v.uids).toEqual(["1.2.a", "1.2.b"]);
    expect(v.filters).toEqual({ studyInstanceUid: "1.2.a,1.2.b" });
    expect(v.id).toBe(3);
  });

  it("空のアルバムは「全件」ではなく、どれにも一致しない条件にする", () => {
    const v = albumView({ id: 1, name: "空" }, []);
    expect(v.filters.studyInstanceUid).toBe(NO_MATCH_STUDY_UID);
    // 空文字のままだと条件が捨てられて全件が出てしまう（fetchStudies は空の値を落とす）
    expect(v.filters.studyInstanceUid).not.toBe("");
  });
});

describe("missingUids", () => {
  const loaded = [{ studyInstanceUid: "1.2.a" }, { studyInstanceUid: "1.2.c" }];
  it("一覧に出てこなかったメンバーだけを返す", () => {
    expect(missingUids(["1.2.a", "1.2.b", "1.2.c"], loaded)).toEqual(["1.2.b"]);
  });
  it("全部あれば空、全部無ければ全部", () => {
    expect(missingUids(["1.2.a"], loaded)).toEqual([]);
    expect(missingUids(["1.2.x", "1.2.y"], loaded)).toEqual(["1.2.x", "1.2.y"]);
  });
  it("読み込み中（null）は判定しない（見つからないと誤って出さない）", () => {
    expect(missingUids(["1.2.a"], null)).toEqual([]);
  });
  it("一覧が 0 件で読み込み済みなら、メンバー全員が見つからない", () => {
    expect(missingUids(["1.2.a"], [])).toEqual(["1.2.a"]);
  });
});

describe("splitUids", () => {
  it("上限ごとに分ける", () => {
    const uids = Array.from({ length: ALBUM_UIDS_PER_REQUEST * 2 + 5 }, (_, i) => `1.2.${i}`);
    const parts = splitUids(uids);
    expect(parts.map((p) => p.length)).toEqual([ALBUM_UIDS_PER_REQUEST, ALBUM_UIDS_PER_REQUEST, 5]);
    expect(parts.flat()).toEqual(uids);
  });
  it("空は 0 回", () => {
    expect(splitUids([])).toEqual([]);
  });
});
