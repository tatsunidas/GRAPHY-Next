/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import { sopFromImageId, frameOfImageId, imageIdForXaFrame } from "./imageId";

// apiBase() は window を要するため、`imageId.ts` が組み立てるのと同じ形を直接書く。
const SOP = "1.2.826.0.1.3680043.8.498.5416630003827624298512855";
const BASE = "wadouri:http://localhost:8090";
const WEB = `${BASE}/api/studies/1.2.3.4/series/1.2.3.5`;

describe("sopFromImageId — 組み立てた imageId から SOP を戻せる", () => {
  it("standalone の単一インスタンス", () => {
    expect(sopFromImageId(`${BASE}/api/instances/${SOP}/file`)).toBe(SOP);
  });

  it("standalone のフレーム指定", () => {
    expect(sopFromImageId(`${BASE}/api/instances/${SOP}/frames/3/file`)).toBe(SOP);
  });

  it("web（study/series 付き）", () => {
    expect(sopFromImageId(`${WEB}/instances/${SOP}/file`)).toBe(SOP);
    expect(sopFromImageId(`${WEB}/instances/${SOP}/frames/2/file`)).toBe(SOP);
  });

  it("ブランク画像は SOP を持たない", () => {
    expect(sopFromImageId(`${WEB}/blank/file?ipp=1,2,3`)).toBeNull();
  });

  it("他ローダ・想定外の形は null（誤った SOP を返さない）", () => {
    expect(sopFromImageId("graphy-thickslab:foo")).toBeNull();
    expect(sopFromImageId("wadouri:http://localhost/api/other/path")).toBeNull();
    expect(sopFromImageId("")).toBeNull();
  });

  it("URL エンコードされた SOP を復号する", () => {
    expect(sopFromImageId(`wadouri:http://h/api/instances/${encodeURIComponent("1.2.3^4")}/file`)).toBe("1.2.3^4");
  });
});

describe("frameOfImageId — マルチフレームの復元先（2026-08-28）", () => {
  it("&frame= の 1 origin を 0 origin にして返す", () => {
    expect(frameOfImageId("wadouri:http://x/instances/1.2.3/file&frame=1")).toBe(0);
    expect(frameOfImageId("wadouri:http://x/instances/1.2.3/file&frame=27")).toBe(26);
  });

  it("?frame= 区切りでも読む", () => {
    expect(frameOfImageId("wadouri:http://x/instances/1.2.3/file?frame=5")).toBe(4);
  });

  it("フレーム指定が無ければ null（単一フレーム）", () => {
    expect(frameOfImageId("wadouri:http://x/instances/1.2.3/file")).toBeNull();
  });

  it("壊れた値は null（0 や負を 0 origin と誤読しない）", () => {
    expect(frameOfImageId("wadouri:http://x/file&frame=0")).toBeNull();
    expect(frameOfImageId("wadouri:http://x/file&frame=abc")).toBeNull();
  });

  it("🔴 imageIdForXaFrame と往復する（+1 / −1 のずれを固定）", () => {
    // imageId の組み立ては apiBase() を通るので window が要る（node 環境には無い）。
    vi.stubGlobal("window", { __GRAPHY_API_BASE__: "http://localhost:8080" });
    try {
      for (const f of [0, 1, 9, 128]) {
        expect(frameOfImageId(imageIdForXaFrame("standalone", "1.2.3", f))).toBe(f);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
