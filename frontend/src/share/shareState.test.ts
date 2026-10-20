/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "../http";
import type { Study } from "../api";
import { shareStateFromError, shareStateFromStudies } from "./shareState";

const study = { studyInstanceUid: "1.2.3" } as Study;

describe("shareStateFromStudies", () => {
  it("検査があれば ready（先頭）", () => {
    expect(shareStateFromStudies([study])).toEqual({ kind: "ready", study });
  });
  it("空・未取得は invalid（空の画面を ready にしない）", () => {
    expect(shareStateFromStudies([])).toEqual({ kind: "invalid" });
    expect(shareStateFromStudies(null)).toEqual({ kind: "invalid" });
    expect(shareStateFromStudies(undefined)).toEqual({ kind: "invalid" });
  });
});

describe("shareStateFromError", () => {
  it("404・401・403 は無効なリンク（理由を区別しない）", () => {
    for (const s of [404, 401, 403]) {
      expect(shareStateFromError(new HttpError("x", s))).toEqual({ kind: "invalid" });
    }
  });
  it("それ以外の失敗は error（無効と取り違えない）", () => {
    expect(shareStateFromError(new HttpError("boom", 500))).toEqual({ kind: "error", message: "boom" });
    expect(shareStateFromError(new TypeError("Failed to fetch"))).toEqual({
      kind: "error",
      message: "Failed to fetch",
    });
    expect(shareStateFromError("x")).toEqual({ kind: "error", message: "x" });
  });
});
