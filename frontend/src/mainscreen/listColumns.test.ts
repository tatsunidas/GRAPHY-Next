/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { ColumnCell } from "../api";
import {
  cellView, newColumnId, parseListColumns, seriesColumns, studyColumns, toRequestColumns, type ListColumn,
} from "./listColumns";

const col = (over: Partial<ListColumn> = {}): ListColumn => ({
  id: "col1", segments: [{ tag: "00181030" }], label: "ProtocolName", where: "both", ...over,
});

describe("parseListColumns", () => {
  it("round-trips a valid setting (private creator and nested segments kept, tags upper-cased)", () => {
    const cols: ListColumn[] = [
      col(),
      col({ id: "col2", segments: [{ tag: "00400275" }, { tag: "0040100b" }], label: "ReqID", where: "study" }),
      col({ id: "col3", segments: [{ tag: "00190001", creator: "VIS-PRIVATE" }], label: "", where: "series" }),
    ];
    const back = parseListColumns(JSON.stringify(cols));
    expect(back.map((c) => c.id)).toEqual(["col1", "col2", "col3"]);
    expect(back[1].segments).toEqual([{ tag: "00400275" }, { tag: "0040100B" }]);
    expect(back[2].segments).toEqual([{ tag: "00190001", creator: "VIS-PRIVATE" }]);
    expect(back[2].where).toBe("series");
  });

  it("falls back to no columns for missing, broken or non-array values", () => {
    expect(parseListColumns(null)).toEqual([]);
    expect(parseListColumns(undefined)).toEqual([]);
    expect(parseListColumns("")).toEqual([]);
    expect(parseListColumns("{")).toEqual([]);
    expect(parseListColumns('{"id":"a"}')).toEqual([]);
  });

  it("drops malformed entries without losing the good ones", () => {
    const raw = JSON.stringify([
      col(),
      { id: "bad1", segments: [{ tag: "XYZ" }], label: "x", where: "both" }, // not 8 hex digits
      { id: "bad2", segments: [], label: "x", where: "both" }, // empty tag specification
      { id: "", segments: [{ tag: "00100010" }] }, // empty id
      { id: "col1", segments: [{ tag: "00100010" }], label: "dup" }, // duplicate id
      { id: "bad3", segments: [{ tag: "00100010", creator: 5 }] }, // creator is not a string
      null,
      7,
    ]);
    expect(parseListColumns(raw).map((c) => c.id)).toEqual(["col1"]);
  });

  it("defaults an unknown 'where' to both", () => {
    const [c] = parseListColumns(JSON.stringify([{ id: "a", segments: [{ tag: "00100010" }], label: "n", where: "nope" }]));
    expect(c.where).toBe("both");
  });
});

describe("column helpers", () => {
  it("newColumnId never collides with an existing id", () => {
    expect(newColumnId([])).toBe("col1");
    expect(newColumnId([col({ id: "col1" }), col({ id: "col2" })])).toBe("col3");
    expect(newColumnId([col({ id: "col2" })])).toBe("col3"); // count + 1 = 2 is in use
  });

  it("study / series filters follow 'where'", () => {
    const cols = [col({ id: "a", where: "study" }), col({ id: "b", where: "series" }), col({ id: "c", where: "both" })];
    expect(studyColumns(cols).map((c) => c.id)).toEqual(["a", "c"]);
    expect(seriesColumns(cols).map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("the request carries only id and tag specification", () => {
    expect(toRequestColumns([col({ segments: [{ tag: "00190001", creator: "C" }] })]))
      .toEqual([{ id: "col1", segments: [{ tag: "00190001", creator: "C" }] }]);
  });
});

describe("cellView", () => {
  const cell = (over: Partial<ColumnCell>): ColumnCell => ({ values: [], state: "OK", incomplete: false, ...over });

  it("shows '…' until the value arrives", () => {
    expect(cellView(undefined)).toEqual({ kind: "loading", text: "…" });
  });

  it("joins the series values with ' / '", () => {
    expect(cellView(cell({ values: ["Chest 1.0", "WB PET"] }))).toMatchObject({ kind: "value", text: "Chest 1.0 / WB PET" });
  });

  it("tells 'tag absent' (—) apart from 'tag present but empty' (blank)", () => {
    const absent = cellView(cell({ state: "ABSENT" }));
    const empty = cellView(cell({ values: [] }));
    expect(absent).toMatchObject({ kind: "absent", text: "—" });
    expect(empty).toMatchObject({ kind: "empty", text: "" });
    expect(absent.text).not.toBe(empty.text);
  });

  it("shows a reason mark (not '—') when the value could not be read", () => {
    expect(cellView(cell({ state: "NOT_LOCAL" }))).toMatchObject({ kind: "notLocal", text: "☁", titleKey: "listCol.notLocal" });
    expect(cellView(cell({ state: "UNREADABLE" }))).toMatchObject({ kind: "unreadable", text: "⚠", titleKey: "listCol.unreadable" });
    expect(cellView(cell({ state: "NOT_RETURNED" }))).toMatchObject({ kind: "notReturned", text: "⚠", titleKey: "listCol.notReturned" });
    for (const s of ["NOT_LOCAL", "UNREADABLE", "NOT_RETURNED"] as const) expect(cellView(cell({ state: s })).text).not.toBe("—");
  });

  it("flags a partly unreadable study value instead of hiding it", () => {
    const v = cellView(cell({ values: ["A"], incomplete: true }));
    expect(v.text).toBe("A ⚠");
    expect(v.titleKey).toBe("listCol.incomplete");
    expect(cellView(cell({ values: [], incomplete: true })).text).toBe("⚠");
  });
});
