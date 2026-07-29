/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import { readColormapName, readInvert, readVoiWindow, voiToWindow } from "./viewportRead";
import { calibratedUnit } from "./imageInfo";

// imageInfo は Cornerstone 本体と dicom-image-loader を読み込む（後者は import しただけで
// worker を expose するため node 環境では落ちる）。calibratedUnit は純関数なので両方差し替える。
vi.mock("@cornerstonejs/core", () => ({
  metaData: { get: vi.fn() },
  imageLoader: { loadAndCacheImage: vi.fn() },
  cache: { getImage: vi.fn() },
  utilities: {},
}));
vi.mock("@cornerstonejs/dicom-image-loader", () => ({ default: {} }));
vi.mock("./suvStore", () => ({ suvForImageId: vi.fn() }));

describe("voiToWindow", () => {
  it("voiRange を Window Center/Width に変換する", () => {
    expect(voiToWindow({ lower: -160, upper: 240 })).toEqual({ center: 40, width: 400 });
  });

  it("VOI 未確定（欠落・非有限・幅 0 以下）は null", () => {
    // 呼び出し側は null を見て DICOM 既定ウィンドウへフォールバックする。
    expect(voiToWindow(undefined)).toBeNull();
    expect(voiToWindow(null)).toBeNull();
    expect(voiToWindow({})).toBeNull();
    expect(voiToWindow({ lower: NaN, upper: 100 })).toBeNull();
    expect(voiToWindow({ lower: 50, upper: 50 })).toBeNull();
    expect(voiToWindow({ lower: 100, upper: 0 })).toBeNull();
  });
});

describe("readVoiWindow / readColormapName / readInvert", () => {
  const vp = (props: unknown) => ({ getProperties: () => props });

  it("getProperties から読む", () => {
    const v = vp({ voiRange: { lower: 0, upper: 100 }, colormap: { name: "hot" }, invert: true });
    expect(readVoiWindow(v)).toEqual({ center: 50, width: 100 });
    expect(readColormapName(v)).toBe("hot");
    expect(readInvert(v)).toBe(true);
  });

  it("内部グレースケール名は LUT 未適用（null）に畳む", () => {
    const v = vp({ colormap: { name: "graphy-gray" } });
    expect(readColormapName(v, "graphy-gray")).toBeNull();
    // grayName を渡さない automator 側は生の名前のまま。
    expect(readColormapName(v)).toBe("graphy-gray");
  });

  it("getProperties が無い/投げるビューポートでも落ちない", () => {
    expect(readVoiWindow({})).toBeNull();
    expect(readColormapName({})).toBeNull();
    expect(readInvert({})).toBe(false);
    const boom = {
      getProperties: () => {
        throw new Error("disposed");
      },
    };
    expect(readVoiWindow(boom)).toBeNull();
    expect(readInvert(boom)).toBe(false);
  });
});

describe("calibratedUnit", () => {
  it("RescaleType があればそれを使う", () => {
    expect(calibratedUnit({ modality: "PT", rescaleType: "BQML" })).toBe("BQML");
  });

  it('"US"（未指定）は無視し、CT だけ HU にフォールバックする', () => {
    expect(calibratedUnit({ modality: "CT", rescaleType: "US" })).toBe("HU");
    expect(calibratedUnit({ modality: "CT" })).toBe("HU");
    expect(calibratedUnit({ modality: "MR" })).toBe("");
    expect(calibratedUnit(undefined)).toBe("");
  });
});
