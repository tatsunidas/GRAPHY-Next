/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { canPlaceTextBox, isMeasurableTool, measureToolConfig } from "./roiStatsTextBox";
import { CONTOUR_TOOL_NAMES, contourToolConfig } from "./roiContourTools";
import { sameCornerRows, type RoiStatsCornerRow } from "./roiStatsCorner";
import type { RoiSampleKind, RoiStatsResult } from "./roiStats";

describe("measureToolConfig", () => {
  it("統計を出せるツールでは getTextLines を差し替える", () => {
    for (const tool of [
      "RectangleROI",
      "EllipticalROI",
      "Length",
      "Probe",
      CONTOUR_TOOL_NAMES.polygon,
      CONTOUR_TOOL_NAMES.polyline,
      CONTOUR_TOOL_NAMES.freehand,
      CONTOUR_TOOL_NAMES.freeLine,
    ]) {
      expect(typeof measureToolConfig(tool).getTextLines, tool).toBe("function");
    }
  });

  it("🔴 Angle / Bidirectional は差し替えない（角度や L/W のラベルごと消える）", () => {
    // 統計エンジンの対象外なので、差し替えると既存の計測表示を壊す。
    expect(isMeasurableTool("Angle")).toBe(false);
    expect(isMeasurableTool("Bidirectional")).toBe(false);
    expect(measureToolConfig("Angle").getTextLines).toBeUndefined();
    expect(measureToolConfig("Bidirectional").getTextLines).toBeUndefined();
  });

  it("輪郭系の既存設定（補間方法・開閉）を保つ", () => {
    // ポリゴンに直線補間を明示する設定を落とすと「ポリゴンなのに曲線で描かれる」に戻る。
    for (const tool of Object.values(CONTOUR_TOOL_NAMES)) {
      expect(measureToolConfig(tool)).toMatchObject(contourToolConfig(tool));
    }
  });

  it("getTextLines は同一の関数参照（ツール登録は 1 回きりなので差し替えられない）", () => {
    expect(measureToolConfig("RectangleROI").getTextLines).toBe(
      measureToolConfig("EllipticalROI").getTextLines,
    );
  });
});

describe("sameCornerRows", () => {
  const row = (over: Partial<RoiStatsCornerRow> = {}): RoiStatsCornerRow => ({
    uid: "a",
    index: 1,
    label: "肝S6",
    summary: "12.4 mm²",
    cx: 100,
    cy: 50,
    selected: false,
    ...over,
  });

  it("同じ内容なら同じ", () => {
    expect(sameCornerRows([row()], [row()])).toBe(true);
  });

  it("0.5px 未満のカメラの揺れでは再レンダしない", () => {
    expect(sameCornerRows([row()], [row({ cx: 100.3 })])).toBe(true);
    expect(sameCornerRows([row()], [row({ cx: 101 })])).toBe(false);
  });

  it("値・選択・件数の変化は拾う", () => {
    expect(sameCornerRows([row()], [row({ summary: "13.0 mm²" })])).toBe(false);
    expect(sameCornerRows([row()], [row({ selected: true })])).toBe(false);
    expect(sameCornerRows([row()], [])).toBe(false);
  });

  it("バッジが出せない（null）状態も区別する", () => {
    expect(sameCornerRows([row({ cx: null })], [row({ cx: null })])).toBe(true);
    expect(sameCornerRows([row({ cx: null })], [row({ cx: 100 })])).toBe(false);
  });
});

describe("canPlaceTextBox", () => {
  const stats = (kind: RoiSampleKind): RoiStatsResult => ({
    roiUid: "u",
    tool: "GraphyFreehandROI",
    imageId: "wadouri:x",
    geometry: { kind, sampleCount: 10, spatiallyCalibrated: true },
    computedAt: 0,
    warnings: [],
  });

  it("🚨 描いている最中の輪郭（polyline が空 / 1 点）には行を返させない", () => {
    // 上流の `_renderStats` は getTextLines が空でないときだけ textBox の位置計算へ進み、
    // そこで polyline の先頭 2 点を使う。空や 1 点だと
    // `Cannot read properties of undefined (reading '1')` で落ちる（実機で踏んだ）。
    expect(canPlaceTextBox({ contour: { polyline: [] } }, stats("area"))).toBe(false);
    expect(canPlaceTextBox({ contour: { polyline: [[0, 0, 0]] } }, stats("area"))).toBe(false);
    expect(
      canPlaceTextBox({ contour: { polyline: [[0, 0, 0], [1, 1, 0]] } }, stats("area")),
    ).toBe(true);
  });

  it("polyline が無いツールは handles.points を見る（矩形・楕円・長さ）", () => {
    expect(canPlaceTextBox({ handles: { points: [[0, 0, 0]] } }, stats("line"))).toBe(false);
    expect(canPlaceTextBox({ handles: { points: [[0, 0, 0], [1, 0, 0]] } }, stats("line"))).toBe(true);
  });

  it("polyline を優先する（上流が位置計算に使うのはこちら）", () => {
    // handles.points が埋まっていても、上流は polyline で位置を決めるので落ちる。
    const data = { contour: { polyline: [] }, handles: { points: [[0, 0, 0], [1, 0, 0]] } };
    expect(canPlaceTextBox(data, stats("area"))).toBe(false);
  });

  it("プローブは 1 点で足りる（別経路でハンドル位置に描く）", () => {
    expect(canPlaceTextBox({ handles: { points: [[5, 5, 0]] } }, stats("point"))).toBe(true);
    expect(canPlaceTextBox({ handles: { points: [] } }, stats("point"))).toBe(false);
  });

  it("data が壊れていても落ちない", () => {
    expect(canPlaceTextBox(null, stats("area"))).toBe(false);
    expect(canPlaceTextBox({}, stats("area"))).toBe(false);
  });
});
