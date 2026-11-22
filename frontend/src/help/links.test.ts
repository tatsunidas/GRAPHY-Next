// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSafeExternalUrl, openExternal } from "./links";

afterEach(() => vi.restoreAllMocks());

describe("openExternal（外部で開く URL の検査）", () => {
  it("許可するのは https・http・mailto だけ", () => {
    for (const ok of ["https://a.example/", "http://a.example/", "mailto:a@example.org", "HTTPS://A.EXAMPLE/"]) expect(isSafeExternalUrl(ok), ok).toBe(true);
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "//a.example/", "/rel", "", "vbscript:x"]) expect(isSafeExternalUrl(bad), bad).toBe(false);
  });
  it("Web 側（window.open）でも、許可しないスキームは開かない（負例）。許可するものは noopener で開く", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openExternal("javascript:alert(1)");
    openExternal("file:///etc/passwd");
    expect(open).not.toHaveBeenCalled();
    openExternal("https://a.example/");
    expect(open).toHaveBeenCalledWith("https://a.example/", "_blank", "noopener,noreferrer");
  });
});
