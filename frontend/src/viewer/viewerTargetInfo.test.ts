/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 動画タイルの H1 登録（`registerViewerTargetInfo`）。
 *
 * 🚨 **これが無いと、動画に振り分けたシリーズはプラグインから「存在しない」ことになる。**
 * 実際に起きた: US Multi-frame(H.264) を Viewer2D から動画再生器へ回した直後、
 * UVS プラグインの `getTargets()` が空配列を返し、解析が一つも走らなくなった
 * （`fw/uvs-plugin-design.md` §3.1.2）。動画は W/L も画素取得も持てないので
 * `ViewerCommands` は実装できないが、**「いま何を見ているか」だけは名乗れる**。
 */
import { describe, expect, it } from "vitest";

import {
  queryViewerTargetInfo,
  registerViewerTargetInfo,
  type ViewerTargetInfo,
} from "./viewerCommands";

const videoTarget = (sop: string): ViewerTargetInfo => ({
  patientKey: "P1",
  studyUid: "1.2.3",
  studyDate: null,
  seriesUid: "1.2.3.4",
  seriesLabel: "1: US",
  imageId: "",
  sopInstanceUid: sop,
  apiBase: "http://localhost:18090",
  kind: "video",
  sliceIndex: 0,
  sliceCount: 1,
  c: 0,
  t: 0,
  modality: "",
});

describe("registerViewerTargetInfo", () => {
  it("登録した対象を tileId で引ける", () => {
    const off = registerViewerTargetInfo("tile-1", () => videoTarget("sop-a"));
    try {
      const info = queryViewerTargetInfo("tile-1");
      expect(info?.sopInstanceUid).toBe("sop-a");
      // 🔑 JAR 面のプラグインはこれで backend の場所を知る（自分では分からない）。
      expect(info?.apiBase).toBe("http://localhost:18090");
      // 🔴 動画には cornerstone の像が無い。imageId を当てにさせない。
      expect(info?.kind).toBe("video");
      expect(info?.imageId).toBe("");
    } finally {
      off();
    }
  });

  it("解除したら引けなくなる（タイルを閉じた後に古い対象を返さない）", () => {
    const off = registerViewerTargetInfo("tile-2", () => videoTarget("sop-b"));
    off();
    expect(queryViewerTargetInfo("tile-2")).toBeNull();
  });

  it("未登録の tileId は null（2D タイルはこちらに来ない）", () => {
    expect(queryViewerTargetInfo("tile-none")).toBeNull();
  });

  it("解除は自分の登録だけを消す（後から上書きされていたら触らない）", () => {
    const off1 = registerViewerTargetInfo("tile-3", () => videoTarget("sop-old"));
    const off2 = registerViewerTargetInfo("tile-3", () => videoTarget("sop-new"));
    off1(); // 古い登録の解除が、新しい登録を巻き添えにしないこと
    expect(queryViewerTargetInfo("tile-3")?.sopInstanceUid).toBe("sop-new");
    off2();
    expect(queryViewerTargetInfo("tile-3")).toBeNull();
  });

  it("取得側が投げても null に丸める（描画途中のタイルで画面を落とさない）", () => {
    const off = registerViewerTargetInfo("tile-4", () => {
      throw new Error("まだ準備できていない");
    });
    try {
      expect(queryViewerTargetInfo("tile-4")).toBeNull();
    } finally {
      off();
    }
  });
});
