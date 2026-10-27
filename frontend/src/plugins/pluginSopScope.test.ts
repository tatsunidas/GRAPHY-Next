/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { firstSopOutsideStudy, type SopScopeSource } from "./pluginSopScope";

const study: Record<string, string[]> = { s1: ["a1", "a2"], s2: ["b1"] };
const src: SopScopeSource = {
  listSeriesUids: async () => Object.keys(study),
  listSopUids: async (_st, se) => study[se] ?? [],
};

describe("firstSopOutsideStudy", () => {
  it("同じスタディの別シリーズの SOP は通る（正例）", async () => {
    expect(await firstSopOutsideStudy(["a1", "b1"], "st", src)).toBeNull();
  });
  it("スタディに無い SOP は名指しで返る（負例）", async () => {
    expect(await firstSopOutsideStudy(["a1", "zzz"], "st", src)).toBe("zzz");
  });
  it("空・null・undefined は拒否される（負例）", async () => {
    expect(await firstSopOutsideStudy(["a1", ""], "st", src)).toBe("(none)");
    expect(await firstSopOutsideStudy([null], "st", src)).toBe("(none)");
    expect(await firstSopOutsideStudy([undefined], "st", src)).toBe("(none)");
  });
  it("読めなかったときは通さず例外が出る（読めない ≠ 同じ検査）", async () => {
    const broken: SopScopeSource = { ...src, listSopUids: async () => { throw new Error("net"); } };
    await expect(firstSopOutsideStudy(["a1"], "st", broken)).rejects.toThrow("net");
  });
});
