/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { fusionBlendCss } from "./fusionBlend";

describe("fusionBlendCss", () => {
  it("差分・乗算・通常はそのまま、知らない値と未指定は通常", () => {
    expect(fusionBlendCss("difference")).toBe("difference");
    expect(fusionBlendCss("multiply")).toBe("multiply");
    expect(fusionBlendCss("normal")).toBe("normal");
    expect(fusionBlendCss("screen")).toBe("normal");
    expect(fusionBlendCss(undefined)).toBe("normal");
  });
});
