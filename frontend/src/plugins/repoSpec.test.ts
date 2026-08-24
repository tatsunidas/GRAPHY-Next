/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";

import { normalizeRepoSpec } from "./repoSpec";

describe("プラグイン導入欄の入力の正規化", () => {
  it("owner/repo はそのまま通る", () => {
    expect(normalizeRepoSpec("tatsunidas/graphy-next-plugin-mean-filter")).toBe(
      "tatsunidas/graphy-next-plugin-mean-filter",
    );
    expect(normalizeRepoSpec("  tatsunidas/mean-filter  ")).toBe("tatsunidas/mean-filter");
  });

  it("★ブラウザから貼った URL を受け取る（これができずに導入が詰まっていた）", () => {
    const want = "tatsunidas/graphy-next-plugin-mean-filter";
    expect(normalizeRepoSpec("https://github.com/tatsunidas/graphy-next-plugin-mean-filter")).toBe(want);
    expect(normalizeRepoSpec("http://github.com/tatsunidas/graphy-next-plugin-mean-filter")).toBe(want);
    expect(normalizeRepoSpec("https://www.github.com/tatsunidas/graphy-next-plugin-mean-filter")).toBe(want);
    expect(normalizeRepoSpec("github.com/tatsunidas/graphy-next-plugin-mean-filter")).toBe(want);
    expect(normalizeRepoSpec("https://github.com/tatsunidas/graphy-next-plugin-mean-filter/")).toBe(want);
    expect(normalizeRepoSpec("https://github.com/tatsunidas/graphy-next-plugin-mean-filter.git")).toBe(want);
    expect(normalizeRepoSpec("git@github.com:tatsunidas/graphy-next-plugin-mean-filter.git")).toBe(want);
  });

  it("owner/repo より後ろは落とす（リリース頁やツリーを貼っても通る）", () => {
    expect(normalizeRepoSpec("https://github.com/tatsunidas/mean-filter/tree/main/src")).toBe(
      "tatsunidas/mean-filter",
    );
    expect(normalizeRepoSpec("https://github.com/tatsunidas/mean-filter/releases/tag/v0.1.0")).toBe(
      "tatsunidas/mean-filter",
    );
    expect(normalizeRepoSpec("https://github.com/tatsunidas/mean-filter?tab=readme#top")).toBe(
      "tatsunidas/mean-filter",
    );
  });

  it("★github.com 以外のホストは受けない（backend の SSRF ガードを UI で薄めない）", () => {
    expect(normalizeRepoSpec("https://gitlab.com/owner/repo")).toBeNull();
    expect(normalizeRepoSpec("https://evil.example.com/owner/repo")).toBeNull();
    expect(normalizeRepoSpec("https://github.com.evil.example/owner/repo")).toBeNull();
  });

  it("解釈できないものは null", () => {
    expect(normalizeRepoSpec("")).toBeNull();
    expect(normalizeRepoSpec("   ")).toBeNull();
    expect(normalizeRepoSpec("mean-filter")).toBeNull();
    expect(normalizeRepoSpec("owner/")).toBeNull();
    expect(normalizeRepoSpec("owner/re po")).toBeNull();
    expect(normalizeRepoSpec("owner/repo$")).toBeNull();
  });
});
