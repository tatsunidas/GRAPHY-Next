import { describe, expect, it } from "vitest";
import { srMeasurementPayload } from "./srPayload";

describe("srMeasurementPayload", () => {
  it("単位の省略は null のまま送る（mm を補わない）", () => {
    expect(srMeasurementPayload({ type: "volume", value: 6.8 })).toEqual({ type: "volume", value: 6.8, unit: null, name: null });
    expect(srMeasurementPayload({ type: "percent", value: 55.2, name: "Ejection fraction" })).toEqual({
      type: "percent",
      value: 55.2,
      unit: null,
      name: "Ejection fraction",
    });
  });

  it("明示した単位と名前はそのまま通る", () => {
    expect(srMeasurementPayload({ type: "longAxis", value: 12, unit: "mm" })).toEqual({ type: "longAxis", value: 12, unit: "mm", name: null });
    expect(srMeasurementPayload({ type: "score", value: 4, unit: "{score}", name: "PI-RADS" })).toEqual({
      type: "score",
      value: 4,
      unit: "{score}",
      name: "PI-RADS",
    });
  });
});
