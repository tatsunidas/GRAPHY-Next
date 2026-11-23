/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { glamFeaturesCsv } from "./GlamFeatureTable";

describe("GLAM 特徴量の CSV", () => {
  const features = { SecondVirialCoefficient_Mean: 1.5, SecondVirialCoefficient_Variance: null };

  it("既存の列（name,value）と順は変えず、末尾に値の単位と校正を足す", () => {
    const rows = glamFeaturesCsv(features, "SUVbw", "bw;scale=0.001").split("\r\n");
    expect(rows[0]).toBe("name,value,value_unit,calibration");
    expect(rows[1].split(",").slice(0, 2)).toEqual(["SecondVirialCoefficient_Mean", "1.5"]);
    expect(rows[1]).toBe("SecondVirialCoefficient_Mean,1.5,SUVbw,bw;scale=0.001");
    expect(rows[2]).toBe("SecondVirialCoefficient_Variance,,SUVbw,bw;scale=0.001"); // null は空
    expect(rows).toHaveLength(3); // 特徴に無い名前の行は出さない
  });

  it("古い保存済みの解析（単位・校正なし）は空の列で出す。校正なしの CT は単位だけ", () => {
    expect(glamFeaturesCsv(features).split("\r\n")[1]).toBe("SecondVirialCoefficient_Mean,1.5,,");
    expect(glamFeaturesCsv(features, "HU", "").split("\r\n")[1]).toBe("SecondVirialCoefficient_Mean,1.5,HU,");
  });

  it("カンマ・引用符を含む値は引用する", () => {
    expect(glamFeaturesCsv(features, "a,b", 'x"y').split("\r\n")[1]).toBe('SecondVirialCoefficient_Mean,1.5,"a,b","x""y"');
  });
});
