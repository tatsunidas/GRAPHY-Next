/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";

import type { XaPresentationState } from "../api";
import { appliedItems, planPresentation } from "./xaPresentationApply";

function state(over: Partial<XaPresentationState> = {}): XaPresentationState {
  return {
    sopInstanceUid: "1.2.3.99",
    sopClassUid: "1.2.840.10008.5.1.4.1.1.11.5",
    label: "QCA",
    description: "",
    creator: "",
    referencedImages: [{ seriesInstanceUid: "1.2.3.9", sopInstanceUid: "1.2.3.10", frameNumbers: [1, 2, 3] }],
    voi: { windowCenter: 1200, windowWidth: 900 },
    invert: false,
    rotation: 0,
    flipHorizontal: false,
    mask: null,
    calibration: null,
    polylines: [],
    texts: [],
    warnings: [],
    ...over,
  };
}

describe("planPresentation — 参照先", () => {
  it("参照していない画像には当てない", () => {
    const plan = planPresentation(state(), "1.2.3.OTHER", 10);
    expect(plan.matchesImage).toBe(false);
    expect(plan.voi).toBeNull();
    expect(plan.dsa).toBeNull();
  });

  it("フレーム番号は 1 origin から 0 origin へ一度だけ直す", () => {
    const plan = planPresentation(state(), "1.2.3.10", 10);
    expect(plan.frameIndices).toEqual([0, 1, 2]);
  });

  it("フレーム数を超える参照は落とす（存在しないフレームを選ばない）", () => {
    const plan = planPresentation(state({ referencedImages: [
      { seriesInstanceUid: "1.2.3.9", sopInstanceUid: "1.2.3.10", frameNumbers: [1, 99] },
    ] }), "1.2.3.10", 10);
    expect(plan.frameIndices).toEqual([0]);
  });
});

describe("planPresentation — DSA", () => {
  const mask = {
    maskFrameNumbers: [1, 2],
    subPixelShiftRow: 1.5,
    subPixelShiftCol: -2.5,
    operation: "AVG_SUB",
    applicableFrom: 1,
    applicableTo: 3,
  };

  it("★行と列を入れ替えて dx（横）/ dy（縦）にする", () => {
    // 🚨 ここを取り違えると体動補正が 90° 回る。DICOM は [row, column]。
    const plan = planPresentation(state({ mask }), "1.2.3.10", 10);
    expect(plan.dsa).toEqual({ maskFrameIndices: [0, 1], dx: -2.5, dy: 1.5 });
  });

  it("★範囲外のマスク指定を 0 番フレームに丸めない", () => {
    const plan = planPresentation(
      state({ mask: { ...mask, maskFrameNumbers: [98, 99] } }),
      "1.2.3.10",
      10,
    );
    expect(plan.dsa).toBeNull();
    expect(plan.unapplied).toContain("maskNotApplicable");
  });
});

describe("planPresentation — 校正", () => {
  it("等方なら当てる", () => {
    const plan = planPresentation(state({ calibration: { mmPerPxRow: 0.225, mmPerPxCol: 0.225 } }), "1.2.3.10", 10);
    expect(plan.mmPerPx).toBeCloseTo(0.225, 9);
    expect(appliedItems(plan)).toContain("calibration");
  });

  it("★行と列で違う値なら当てない（1 値しか持てないので、片方を採ると嘘になる）", () => {
    const plan = planPresentation(state({ calibration: { mmPerPxRow: 0.2, mmPerPxCol: 0.3 } }), "1.2.3.10", 10);
    expect(plan.mmPerPx).toBeNull();
  });
});

describe("planPresentation — 当てられなかったものを言う", () => {
  it("backend の警告をそのまま持ち上げる（値付きは種別だけにする）", () => {
    const plan = planPresentation(
      state({ warnings: ["voiLutData", "graphicUnits:DISPLAY,UNKNOWN", "displayShutter"] }),
      "1.2.3.10",
      10,
    );
    expect(plan.unapplied).toEqual(expect.arrayContaining(["voiLutData", "graphicUnits", "displayShutter"]));
  });

  it("★図形は読めても当て先が無いので「当てられなかった」に入れる", () => {
    const plan = planPresentation(
      state({ polylines: [{ layer: "QCA", graphicType: "POLYLINE", points: [1, 2, 3, 4], filled: false }] }),
      "1.2.3.10",
      10,
    );
    expect(plan.unapplied).toContain("graphics");
  });

  it("何も問題が無ければ空（毎回警告を出して麻痺させない）", () => {
    const plan = planPresentation(state(), "1.2.3.10", 10);
    expect(plan.unapplied).toEqual([]);
    expect(appliedItems(plan)).toEqual(["voi"]);
  });
});
