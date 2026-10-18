/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { TagDumpRow } from "../api";
import { affectsRouting, buildEdits, rowKey, rowLock } from "./tagEditModel";

const rows: TagDumpRow[] = [
  { depth: 0, tag: "(0008,0060)", name: "Modality", vr: "CS", value: "CT" },
  { depth: 0, tag: "(0008,103E)", name: "SeriesDescription", vr: "LO", value: "Chest" },
  { depth: 0, tag: "(0010,0010)", name: "PatientName", vr: "PN", value: "X^Y" },
  { depth: 0, tag: "(0020,000E)", name: "SeriesInstanceUID", vr: "UI", value: "1.2.3" },
  { depth: 0, tag: "(0018,1030)", name: "ProtocolName", vr: "LO", value: "Routine" },
  { depth: 1, tag: "(FFFE,E000)", name: "Item #1", vr: "", value: "" },
];

describe("tagEditModel", () => {
  it("鍵の付く行", () => {
    expect(rowLock(rows[0])).toBeNull();
    expect(rowLock(rows[2])).toBe("patient");
    expect(rowLock(rows[3])).toBe("uid");
    expect(rowLock(rows[5])).toBe("structure");
  });

  it("値を変えた行・消した行だけを送り、元と同じ値は送らない", () => {
    const b = buildEdits(
      rows,
      { [rowKey(0)]: { value: "CT" }, [rowKey(1)]: { value: "Chest 1.0" }, [rowKey(4)]: { remove: true } },
      [],
    );
    expect(b.edits).toEqual([
      { tag: "(0008,103E)", vr: "LO", op: "set", before: "Chest", value: "Chest 1.0" },
      { tag: "(0018,1030)", vr: "LO", op: "remove", before: "Routine" },
    ]);
    expect(b.keys).toEqual([rowKey(1), rowKey(4)]);
    expect(b.problems).toEqual({});
  });

  it("鍵の付いた行の下書きは送らない（画面を迂回しても）", () => {
    const b = buildEdits(rows, { [rowKey(2)]: { value: "A^B" }, [rowKey(3)]: { remove: true } }, []);
    expect(b.edits).toEqual([]);
  });

  it("形の違う値は保存できない理由になる", () => {
    const b = buildEdits(rows, { [rowKey(0)]: { value: "ct" } }, []);
    expect(b.problems).toEqual({ [rowKey(0)]: "badChars" });
  });

  it("追加の行: VR が分かれば画面で検査し、キーワードはサーバーに任せる", () => {
    const b = buildEdits(rows, {}, [
      { key: 1, tag: "StudyComments", vr: "", value: "x" },
      { key: 2, tag: "(0009,1001)", vr: "lo", value: "note" },
      { key: 3, tag: "(0020,0032)", vr: "DS", value: "0\\0\\0" },
      { key: 4, tag: "(0009,1002)", vr: "US", value: "70000" },
      { key: 5, tag: "  ", vr: "", value: "ignored" },
    ]);
    expect(b.edits.map((e) => [e.tag, e.vr, e.value])).toEqual([
      ["StudyComments", undefined, "x"],
      ["(0009,1001)", "LO", "note"],
      ["(0020,0032)", "DS", "0\\0\\0"],
      ["(0009,1002)", "US", "70000"],
    ]);
    expect(b.problems).toEqual({ a3: "geometry", a4: "outOfRange" });
  });

  it("表示の振り分けに効くタグ", () => {
    expect(affectsRouting("(0008,0060)")).toBe(true);
    expect(affectsRouting("(0020,0013)")).toBe(true);
    expect(affectsRouting("(0008,103E)")).toBe(false);
  });
});
