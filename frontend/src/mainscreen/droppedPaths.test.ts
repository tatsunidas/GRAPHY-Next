/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { droppedPaths, hasDroppedFiles } from "./droppedPaths";

const file = (path?: string) => Object.assign(new File([""], "x.dcm"), path === undefined ? {} : { path });

describe("droppedPaths", () => {
  it("ファイルのドラッグだけを受ける", () => {
    expect(hasDroppedFiles(["Files"])).toBe(true);
    expect(hasDroppedFiles(["text/plain"])).toBe(false);
    expect(hasDroppedFiles([])).toBe(false);
    expect(hasDroppedFiles(null)).toBe(false);
  });

  it("絶対パスを取り出し、空・パスなし・重複を除く", () => {
    expect(droppedPaths([file("/a/b"), file(""), file(), file("/a/b"), file("/c")])).toEqual(["/a/b", "/c"]);
    expect(droppedPaths(null)).toEqual([]);
  });
});
