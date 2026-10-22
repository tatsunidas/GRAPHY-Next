import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FUSION_CSV_HEADER,
  fusionCsvCells,
  fusionMeasureForSeries,
  isFusionCalcBlend,
  listFusionMeasure,
  setFusionMeasure,
  subscribeFusionMeasure,
} from "./fusionMeasureContext";

const info = { backgroundSeriesUid: "S1", foregroundLabel: "PET", blend: "difference" as const };

afterEach(() => {
  setFusionMeasure("t1", null);
  setFusionMeasure("t2", null);
});

describe("Fusion 計測コンテキスト", () => {
  it("差分・乗算だけが対象（normal・不明な値・未指定は対象外）", () => {
    expect(isFusionCalcBlend("difference")).toBe(true);
    expect(isFusionCalcBlend("multiply")).toBe(true);
    expect(isFusionCalcBlend("normal")).toBe(false);
    expect(isFusionCalcBlend("screen")).toBe(false);
    expect(isFusionCalcBlend(undefined)).toBe(false);
  });

  it("登録した背景シリーズだけ見つかり、解除すると見つからない", () => {
    setFusionMeasure("t1", info);
    expect(fusionMeasureForSeries("S1")?.blend).toBe("difference");
    expect(fusionMeasureForSeries("S2")).toBeUndefined();
    expect(fusionMeasureForSeries(undefined)).toBeUndefined();
    setFusionMeasure("t1", null);
    expect(fusionMeasureForSeries("S1")).toBeUndefined();
  });

  it("同じ内容の再登録では通知せず、変化・解除では通知する", () => {
    const fn = vi.fn();
    const off = subscribeFusionMeasure(fn);
    setFusionMeasure("t1", info);
    setFusionMeasure("t1", { ...info });
    expect(fn).toHaveBeenCalledTimes(1);
    setFusionMeasure("t1", { ...info, blend: "multiply" });
    expect(fn).toHaveBeenCalledTimes(2);
    setFusionMeasure("t1", null);
    setFusionMeasure("t1", null);
    expect(fn).toHaveBeenCalledTimes(3);
    off();
  });

  it("一覧は変化したときだけ新しい配列になる（useSyncExternalStore の前提）", () => {
    setFusionMeasure("t1", info);
    const a = listFusionMeasure();
    expect(listFusionMeasure()).toBe(a);
    setFusionMeasure("t2", { ...info, backgroundSeriesUid: "S2" });
    expect(listFusionMeasure()).not.toBe(a);
    expect(listFusionMeasure()).toHaveLength(2);
  });

  it("CSV の 3 列：Fusion があれば値、無ければ空セル（0 や '-' で埋めない）", () => {
    expect(FUSION_CSV_HEADER).toHaveLength(3);
    expect(fusionCsvCells(info)).toEqual(["background", "difference", "PET"]);
    expect(fusionCsvCells(undefined)).toEqual(["", "", ""]);
  });
});
