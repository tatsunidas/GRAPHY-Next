import { describe, expect, it } from "vitest";
import type { XaCalibTags } from "./xaCalibration";
import { checkXaInput } from "./xaInputCheck";

/** 整合した入力: 拡大率 1.2（SID 1200 / SOD 1000）、検出器 0.292、患者面 = 0.292 / 1.2。 */
const MAG = 1.2;
const consistent: XaCalibTags = {
  imagerPixelSpacing: [0.292, 0.292],
  pixelSpacing: [0.292 / MAG, 0.292 / MAG],
  distanceSourceToDetector: 1200,
  distanceSourceToPatient: 1000,
  estimatedRadiographicMagnificationFactor: MAG,
};

describe("checkXaInput（3D QCA の入力検査）", () => {
  it("整合した XA 入力は警告も判定不能も出ない", () => {
    expect(checkXaInput(consistent, true)).toEqual({ warnings: [], unknown: [] });
  });

  it("負例: PixelSpacing を 10% ずらすと画素間隔の比が SID/SOD と合わず警告", () => {
    const r = checkXaInput({ ...consistent, pixelSpacing: [0.292 / MAG / 1.1, 0.292 / MAG / 1.1] }, true);
    expect(r.warnings).toEqual(["spacingRatioDiffersFromSidSod"]);
  });

  it("負例: 推定拡大率を 10% ずらすと SID/SOD と合わず警告", () => {
    const r = checkXaInput({ ...consistent, estimatedRadiographicMagnificationFactor: MAG * 1.1 }, true);
    expect(r.warnings).toEqual(["sidSodDiffersFromMagFactor"]);
  });

  it("許容内（約 2%）のずれは警告しない", () => {
    const r = checkXaInput({ ...consistent, estimatedRadiographicMagnificationFactor: MAG * 1.02 }, true);
    expect(r.warnings).toEqual([]);
  });

  it("負例: SC など XA/XRF でない SOP クラスは警告、XA は警告なし", () => {
    expect(checkXaInput(consistent, false).warnings).toEqual(["notXaSopClass"]);
    expect(checkXaInput(consistent, true).warnings).not.toContain("notXaSopClass");
  });

  it("タグが無い項目は判定不能に分け、警告にも合格にも数えない", () => {
    const r = checkXaInput({ imagerPixelSpacing: [0.292, 0.292] }, null);
    expect(r.warnings).toEqual([]);
    expect(r.unknown.sort()).toEqual(["notXaSopClass", "sidSodDiffersFromMagFactor", "spacingRatioDiffersFromSidSod"]);
  });

  it("推定拡大率だけ無い場合は、画素間隔の比の検査は行い、拡大率の検査だけ判定不能", () => {
    const { estimatedRadiographicMagnificationFactor: _omit, ...rest } = consistent;
    const r = checkXaInput(rest, true);
    expect(r).toEqual({ warnings: [], unknown: ["sidSodDiffersFromMagFactor"] });
  });
});
