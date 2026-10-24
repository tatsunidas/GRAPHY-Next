/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { parseLeftPanelOpen, tileListLabel } from "./leftPanel";

describe("parseLeftPanelOpen", () => {
  it("only the string false hides the panel", () => {
    expect(parseLeftPanelOpen("false")).toBe(false);
  });

  it("shows the panel when nothing is stored or the value is unreadable", () => {
    expect(parseLeftPanelOpen(null)).toBe(true);
    expect(parseLeftPanelOpen(undefined)).toBe(true);
    expect(parseLeftPanelOpen("true")).toBe(true);
    expect(parseLeftPanelOpen("")).toBe(true);
    expect(parseLeftPanelOpen("0")).toBe(true);
    expect(parseLeftPanelOpen("{")).toBe(true);
  });
});

describe("tileListLabel", () => {
  it("normal tile: number, modality, description", () => {
    expect(tileListLabel({ series: { seriesNumber: 2, modality: "CT", seriesDescription: "B body" } }))
      .toEqual({ text: "#2 CT B body", concat: false });
  });

  it("fills missing fields without inventing values", () => {
    expect(tileListLabel({ series: {} })).toEqual({ text: "#?", concat: false });
    expect(tileListLabel({ series: { seriesNumber: null, modality: "MR", seriesDescription: null } }))
      .toEqual({ text: "#? MR", concat: false });
  });

  it("concat tile: joins the part labels and flags it", () => {
    expect(tileListLabel({ concat: { labels: ["#1 CT A head", "#2 CT B body"] }, series: { seriesNumber: 1 } }))
      .toEqual({ text: "#1 CT A head + #2 CT B body", concat: true });
  });
});
