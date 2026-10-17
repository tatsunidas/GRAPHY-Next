/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { Series } from "../api";
import { CFM_SOP_CLASS, selectionHasCfm } from "./cfmNotice";

const s = (uid: string, modality: string | null, sop: string | null): Series => ({
  seriesInstanceUid: uid,
  modality,
  seriesNumber: 1,
  seriesDescription: null,
  sopClassUid: sop,
  numberOfInstances: 1,
});

describe("selectionHasCfm", () => {
  const byStudy = new Map([["st", [s("a", "MR", "1.2"), s("b", null, CFM_SOP_CLASS), s("c", "CFM", null)]]]);
  it("選んだシリーズに CFM があるときだけ true", () => {
    expect(selectionHasCfm(byStudy, new Set(["a"]))).toBe(false);
    expect(selectionHasCfm(byStudy, new Set(["a", "b"]))).toBe(true);
    expect(selectionHasCfm(byStudy, new Set(["c"]))).toBe(true);
    expect(selectionHasCfm(byStudy, new Set())).toBe(false);
  });
});
