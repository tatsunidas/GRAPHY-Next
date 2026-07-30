/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import { dicomDateToIso, readColormapName, readInvert, readVoiWindow, resolveSliceIndex, voiToWindow } from "./viewportRead";
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

describe("resolveSliceIndex", () => {
  it("省略時は表示中スライス", () => {
    expect(resolveSliceIndex(undefined, 7, 50)).toBe(7);
  });

  it("指定が範囲内ならそれを使う", () => {
    expect(resolveSliceIndex(0, 7, 50)).toBe(0);
    expect(resolveSliceIndex(49, 7, 50)).toBe(49);
  });

  it("範囲外・非整数は null（末尾へ丸めない）", () => {
    // 丸めると「999 枚目をくれ」と言ったプラグインが末尾スライスを掴んで気付かない。
    expect(resolveSliceIndex(50, 7, 50)).toBeNull();
    expect(resolveSliceIndex(999, 7, 50)).toBeNull();
    expect(resolveSliceIndex(-1, 7, 50)).toBeNull();
    expect(resolveSliceIndex(1.5, 7, 50)).toBeNull();
    expect(resolveSliceIndex(NaN, 7, 50)).toBeNull();
  });

  it("スタックが空・表示 index が壊れている場合は null", () => {
    expect(resolveSliceIndex(undefined, 0, 0)).toBeNull();
    expect(resolveSliceIndex(0, 0, 0)).toBeNull();
    expect(resolveSliceIndex(undefined, 50, 50)).toBeNull();
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

describe("dicomDateToIso", () => {
  it("DICOM の DA を ISO 日付へ変換する", () => {
    expect(dicomDateToIso("20260130")).toBe("2026-01-30");
    expect(dicomDateToIso(" 20260130 ")).toBe("2026-01-30");
  });

  it("区切り入りでも読める（実装によっては入ってくる）", () => {
    expect(dicomDateToIso("2026-01-30")).toBe("2026-01-30");
    expect(dicomDateToIso("2026.01.30")).toBe("2026-01-30");
  });

  it("解釈できない値は null（怪しい日付を通さない）", () => {
    expect(dicomDateToIso("")).toBeNull();
    expect(dicomDateToIso("2026013")).toBeNull();
    expect(dicomDateToIso("abcdefgh")).toBeNull();
    expect(dicomDateToIso(undefined)).toBeNull();
    expect(dicomDateToIso(20260130)).toBeNull();
  });

  it("存在しない日付は null（2 月 30 日を通さない）", () => {
    expect(dicomDateToIso("20260230")).toBeNull();
    expect(dicomDateToIso("20261301")).toBeNull();
    expect(dicomDateToIso("20260100")).toBeNull();
  });

  it("うるう年は正しく通す/弾く", () => {
    expect(dicomDateToIso("20240229")).toBe("2024-02-29");
    expect(dicomDateToIso("20260229")).toBeNull();
  });
});

describe("dicomDateToIso — dicom-image-loader が返すオブジェクト形", () => {
  it("{year, month, day} を受ける（metaData は parseDA を通すので文字列ではない）", () => {
    expect(dicomDateToIso({ year: 2026, month: 1, day: 30 })).toBe("2026-01-30");
    expect(dicomDateToIso({ year: 2026, month: 12, day: 5 })).toBe("2026-12-05");
  });

  it("欠けた/非数値のフィールドは null", () => {
    expect(dicomDateToIso({ year: 2026, month: 1 })).toBeNull();
    expect(dicomDateToIso({ year: "2026", month: 1, day: 30 })).toBeNull();
    expect(dicomDateToIso({})).toBeNull();
    expect(dicomDateToIso(null)).toBeNull();
  });

  it("オブジェクト形でも存在しない日付は null", () => {
    expect(dicomDateToIso({ year: 2026, month: 2, day: 30 })).toBeNull();
    expect(dicomDateToIso({ year: 2026, month: 13, day: 1 })).toBeNull();
  });
});
