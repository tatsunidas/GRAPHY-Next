/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  classifySeriesDisplay,
  classifySeriesRenderability,
  isNonImageSeries,
  isVideoInstance,
  isVideoSopClass,
  isVideoTransferSyntax,
} from "./seriesRenderable";

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

describe("classifySeriesDisplay", () => {
  const VIDEO_PHOTOGRAPHIC = "1.2.840.10008.5.1.4.1.1.77.1.4.1";
  const VIDEO_ENDOSCOPIC = "1.2.840.10008.5.1.4.1.1.77.1.1.1";
  const VIDEO_MICROSCOPIC = "1.2.840.10008.5.1.4.1.1.77.1.2.1";
  const XA = "1.2.840.10008.5.1.4.1.1.12.1"; // X-Ray Angiographic Image Storage
  const CT = "1.2.840.10008.5.1.4.1.1.2";

  it("encapsulated 動画は再生器へ回す（画素が無く Viewer2D で開けないため）", () => {
    for (const sop of [VIDEO_PHOTOGRAPHIC, VIDEO_ENDOSCOPIC, VIDEO_MICROSCOPIC]) {
      expect(classifySeriesDisplay([{ sopClassUid: sop }], "standalone")).toBe("video");
    }
  });

  it("XA のシネは動画扱いしない（通常の画素データが並んだマルチフレームなので Viewer2D で再生できる）", () => {
    expect(classifySeriesDisplay([{ sopClassUid: XA }], "standalone")).toBe("image");
    expect(isVideoSopClass(XA)).toBe(false);
  });

  it("web モードは再生できない（/rendered が索引のローカルファイルを前提にしている）", () => {
    expect(classifySeriesDisplay([{ sopClassUid: VIDEO_PHOTOGRAPHIC }], "web")).toBe("videoUnavailable");
    // 画像シリーズは web でも従来どおり。
    expect(classifySeriesDisplay([{ sopClassUid: CT }], "web")).toBe("image");
  });

  it("判定は先頭インスタンスで決める（混在で画面が割れるのを避ける）", () => {
    expect(
      classifySeriesDisplay([{ sopClassUid: VIDEO_PHOTOGRAPHIC }, { sopClassUid: CT }], "standalone"),
    ).toBe("video");
    expect(
      classifySeriesDisplay([{ sopClassUid: CT }, { sopClassUid: VIDEO_PHOTOGRAPHIC }], "standalone"),
    ).toBe("image");
  });

  it("空・SOP クラス不明は画像扱い（fail-open）", () => {
    expect(classifySeriesDisplay([], "standalone")).toBe("image");
    expect(classifySeriesDisplay([{}], "standalone")).toBe("image");
    expect(classifySeriesDisplay([{ sopClassUid: null }], "standalone")).toBe("image");
  });
});

describe("転送構文で包まれた動画（H.264 の US Multi-frame）", () => {
  // 🚨 実機で「開けるのに真っ黒」を出していたケース。SOP クラスはふつうの画像なので、
  //    転送構文を見ないと Viewer2D へ流れ、dicom-image-loader が H.264 を復号できず何も描かない。
  const US_MULTIFRAME = "1.2.840.10008.5.1.4.1.1.3.1"; // Ultrasound Multi-frame Image Storage
  const H264 = "1.2.840.10008.1.2.4.102";
  const MPEG2 = "1.2.840.10008.1.2.4.100";
  const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";
  const JPEG_LOSSLESS = "1.2.840.10008.1.2.4.70";

  it("H.264 の US Multi-frame は再生器へ回す", () => {
    expect(classifySeriesDisplay([{ sopClassUid: US_MULTIFRAME, transferSyntaxUid: H264 }], "standalone"))
      .toBe("video");
  });

  it("MPEG2 も再生器へ回す（backend が ffmpeg で変換して配信する）", () => {
    expect(classifySeriesDisplay([{ sopClassUid: US_MULTIFRAME, transferSyntaxUid: MPEG2 }], "standalone"))
      .toBe("video");
  });

  it("非圧縮・JPEG の US Multi-frame は従来どおり画像として開く", () => {
    for (const ts of [EXPLICIT_VR_LE, JPEG_LOSSLESS]) {
      expect(classifySeriesDisplay([{ sopClassUid: US_MULTIFRAME, transferSyntaxUid: ts }], "standalone"))
        .toBe("image");
    }
  });

  it("web モードでは再生できないと伝える（黙って真っ黒にしない）", () => {
    expect(classifySeriesDisplay([{ sopClassUid: US_MULTIFRAME, transferSyntaxUid: H264 }], "web"))
      .toBe("videoUnavailable");
  });

  it("転送構文が取れない（web の QIDO）なら SOP クラスだけで判定する", () => {
    expect(classifySeriesDisplay([{ sopClassUid: US_MULTIFRAME }], "standalone")).toBe("image");
    expect(classifySeriesDisplay([{ sopClassUid: US_MULTIFRAME, transferSyntaxUid: null }], "standalone"))
      .toBe("image");
  });

  it("isVideoInstance は SOP クラスと転送構文のどちらか一方でも動画なら真", () => {
    expect(isVideoInstance({ sopClassUid: US_MULTIFRAME, transferSyntaxUid: H264 })).toBe(true);
    expect(isVideoInstance({ sopClassUid: "1.2.840.10008.5.1.4.1.1.77.1.4.1" })).toBe(true);
    expect(isVideoInstance({ sopClassUid: US_MULTIFRAME, transferSyntaxUid: EXPLICIT_VR_LE })).toBe(false);
    expect(isVideoInstance({})).toBe(false);
  });

  it("isVideoTransferSyntax は前後の空白を無視する（索引の値が汚れていることがある）", () => {
    expect(isVideoTransferSyntax(` ${H264} `)).toBe(true);
    expect(isVideoTransferSyntax(EXPLICIT_VR_LE)).toBe(false);
    expect(isVideoTransferSyntax(null)).toBe(false);
    // SOP クラス側の判定は転送構文を見ない（役割が違う）。
    expect(isVideoSopClass(US_MULTIFRAME)).toBe(false);
  });
});
