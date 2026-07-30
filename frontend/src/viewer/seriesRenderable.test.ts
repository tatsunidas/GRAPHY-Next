/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { classifySeriesRenderability, isNonImageSeries } from "./seriesRenderable";

describe("classifySeriesRenderability", () => {
  it("RTSTRUCT は SOP クラスで弾く（実機で未処理例外を出していたケース）", () => {
    const r = classifySeriesRenderability({ sopClassUid: "1.2.840.10008.5.1.4.1.1.481.3", modality: "RTSTRUCT" });
    expect(r).toEqual({ renderable: false, kind: "RT Structure Set", by: "sopClass" });
  });

  it("CT / MR / SC などの画像は開ける", () => {
    expect(classifySeriesRenderability({ sopClassUid: "1.2.840.10008.5.1.4.1.1.2", modality: "CT" }).renderable).toBe(true);
    expect(classifySeriesRenderability({ sopClassUid: "1.2.840.10008.5.1.4.1.1.4", modality: "MR" }).renderable).toBe(true);
    // Secondary Capture（テクスチャマップ等の派生シリーズ）。
    expect(classifySeriesRenderability({ sopClassUid: "1.2.840.10008.5.1.4.1.1.7", modality: "CT" }).renderable).toBe(true);
  });

  it("DICOM SEG(66.4) は labelmap を持つので開ける / Surface SEG(66.5) は開けない", () => {
    // どちらも Modality=SEG。Modality だけでは区別できないので SOP クラスを優先する。
    expect(classifySeriesRenderability({ sopClassUid: "1.2.840.10008.5.1.4.1.1.66.4", modality: "SEG" }).renderable).toBe(true);
    const surface = classifySeriesRenderability({ sopClassUid: "1.2.840.10008.5.1.4.1.1.66.5", modality: "SEG" });
    expect(surface.renderable).toBe(false);
    expect(surface.kind).toBe("Surface Segmentation");
  });

  it("SOP クラスが分かれば Modality は見ない（SOP クラスが結論）", () => {
    // 索引の Modality が汚れていても、SOP クラスが画像なら開ける。
    const r = classifySeriesRenderability({ sopClassUid: "1.2.840.10008.5.1.4.1.1.2", modality: "RTSTRUCT" });
    expect(r.renderable).toBe(true);
  });

  it("SOP クラスが無ければ Modality で判定する（web の QIDO 経路）", () => {
    expect(classifySeriesRenderability({ modality: "RTSTRUCT" })).toEqual({
      renderable: false,
      kind: "RT Structure Set",
      by: "modality",
    });
    expect(classifySeriesRenderability({ sopClassUid: null, modality: "sr" }).kind).toBe("Structured Report");
    expect(classifySeriesRenderability({ modality: "CT" }).renderable).toBe(true);
  });

  it("Encapsulated PDF / 構造化レポート / 表示状態も弾く", () => {
    expect(isNonImageSeries({ sopClassUid: "1.2.840.10008.5.1.4.1.1.104.1" })).toBe(true);
    expect(isNonImageSeries({ sopClassUid: "1.2.840.10008.5.1.4.1.1.88.33" })).toBe(true);
    expect(isNonImageSeries({ sopClassUid: "1.2.840.10008.5.1.4.1.1.11.1" })).toBe(true);
  });

  it("未知・空は開ける扱い（fail-open。画像なのに開けない方が害が大きい）", () => {
    expect(classifySeriesRenderability({}).renderable).toBe(true);
    expect(classifySeriesRenderability({ sopClassUid: "", modality: "" }).renderable).toBe(true);
    expect(classifySeriesRenderability({ sopClassUid: "1.2.3.4.5" }).renderable).toBe(true);
    expect(classifySeriesRenderability({ modality: "XA" }).renderable).toBe(true);
  });
});
