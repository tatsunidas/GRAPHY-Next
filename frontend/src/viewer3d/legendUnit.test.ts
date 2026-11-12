import { describe, expect, it, vi } from "vitest";

// pixelCalibration は Cornerstone を import する。legendUnit が使うのは純関数（defaultUnitForModality）だけ。
vi.mock("@cornerstonejs/core", () => ({ metaData: { get: () => undefined }, cache: { getImage: () => undefined } }));
vi.mock("../viewer/suvStore", () => ({ suvForImageId: () => undefined }));

import { legendUnit } from "./legendUnit";

describe("legendUnit", () => {
  it("CT は HU", () => {
    expect(legendUnit("HU", "CT")).toBe("HU");
    expect(legendUnit(undefined, "CT")).toBe("HU");
  });

  it("🔴 未校正の PET は Bq/ml（以前は『PT なら SUV』で、Bq/mL の数値に SUV と付いていた）", () => {
    expect(legendUnit("Bq/ml", "PT")).toBe("Bq/ml");
    expect(legendUnit(undefined, "PT")).toBe("Bq/ml");
    expect(legendUnit(undefined, "PT")).not.toBe("SUV");
    expect(legendUnit("BQML", "PT")).toBe("BQML"); // RescaleType があればそのまま
  });

  it("校正値を保存したシリーズ（OT）は、RescaleType の単位がそのまま出る", () => {
    for (const u of ["%ID/cc", "SUVR", "SUVbw", "SUVlbm", "SUVbsa"]) expect(legendUnit(u, "OT")).toBe(u);
  });

  it("raw（校正が無い印）・決まらない単位は空（捏造しない）", () => {
    expect(legendUnit("raw", "MR")).toBe("");
    expect(legendUnit("raw", "PT")).toBe("");
    expect(legendUnit(undefined, "MR")).toBe("");
    expect(legendUnit(undefined, null)).toBe("");
    expect(legendUnit("", "OT")).toBe("");
  });
});
