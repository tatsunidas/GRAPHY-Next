/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { calibrationToSend, isCalibratedParametricMap, showsPetCalibration } from "./PetCalibrationField";

const PM = "1.2.840.10008.5.1.4.1.1.30";
const PET_IMAGE = "1.2.840.10008.5.1.4.1.1.128";

describe("PET の校正の欄の出し分け", () => {
  it("正例: PT かつ Parametric Map は欄を出さず、選択に関わらず auto を送る", () => {
    expect(isCalibratedParametricMap(PM)).toBe(true);
    expect(showsPetCalibration("PT", PM)).toBe(false);
    expect(calibrationToSend("PT", "none", PM)).toBe("auto");
    expect(calibrationToSend("PT", "bw", PM)).toBe("auto");
  });
  it("負例: PT の原画像は欄を出し、選択をそのまま送る", () => {
    expect(isCalibratedParametricMap(PET_IMAGE)).toBe(false);
    expect(showsPetCalibration("PT", PET_IMAGE)).toBe(true);
    expect(calibrationToSend("PT", "bw", PET_IMAGE)).toBe("bw");
  });
  it("SOP クラスが null・未指定（web）は従来どおり", () => {
    for (const sop of [null, undefined, ""]) {
      expect(showsPetCalibration("PT", sop)).toBe(true);
      expect(calibrationToSend("PT", "none", sop)).toBe("none");
    }
    expect(calibrationToSend("PT", "none")).toBe("none");
  });
  it("PT 以外は SOP クラスに関わらず欄なし・auto", () => {
    expect(showsPetCalibration("CT", PET_IMAGE)).toBe(false);
    expect(calibrationToSend("CT", "bw", null)).toBe("auto");
  });
});
