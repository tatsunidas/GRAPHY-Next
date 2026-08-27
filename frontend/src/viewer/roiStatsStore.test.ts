/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 統計キャッシュの「静かに間違う」経路の回帰テスト。
 *
 * <p>ここで守りたいのは 3 つ:
 * ① 画素をまだ読めていない結果を**確定扱いにしない**（一度取りこぼすと二度と出ない、を防ぐ）
 * ② 形が変わったら**作り直す**（`annotation.invalidated` は当てにできない）
 * ③ 入力を解決できない ROI にも結果を書く（`getTextLines` の空回りを防ぐ）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Cornerstone のうち、このモジュールが触る口だけを差し替える ──────────────
const annotations: Record<string, unknown>[] = [];
let sliceLoaded = true;

vi.mock("@cornerstonejs/core", () => ({
  eventTarget: { addEventListener: () => undefined, removeEventListener: () => undefined },
  getRenderingEngines: () => [],
  metaData: { get: () => ({ columnPixelSpacing: 0.5, rowPixelSpacing: 0.5 }) },
  utilities: {
    worldToImageCoords: (_id: string, w: number[]) => [w[0], w[1]] as [number, number],
  },
}));

vi.mock("@cornerstonejs/tools", () => ({
  annotation: {
    state: {
      getAnnotation: (uid: string) => annotations.find((a) => a.annotationUID === uid),
      getAllAnnotations: () => annotations,
    },
  },
  Enums: { Events: {} },
}));

vi.mock("@cornerstonejs/tools/utilities", () => ({
  triggerAnnotationRenderForViewportIds: () => undefined,
}));

vi.mock("./pixelCalibration", () => ({
  readModalitySlice: async () => (sliceLoaded ? slice() : null),
  readModalitySliceSync: () => (sliceLoaded ? slice() : null),
  resolveValueUnit: () => "HU",
}));

function slice() {
  return { values: new Float32Array(32 * 32).fill(70), width: 32, height: 32, unit: "HU" };
}

import { computeRoiStatsAsync, computeRoiStatsNow, getRoiStats, invalidateAllRoiStats } from "./roiStatsStore";

function rect(uid: string, x0: number, y0: number, x1: number, y1: number) {
  return {
    annotationUID: uid,
    metadata: { toolName: "RectangleROI", referencedImageId: "wadouri:x" },
    data: {
      handles: {
        points: [
          [x0, y0, 0],
          [x1, y0, 0],
          [x1, y1, 0],
          [x0, y1, 0],
        ],
      },
    },
  };
}

let seq = 0;
/** テストごとに別の uid（ストアはモジュール変数なのでテストを跨いで残る）。 */
const uid = () => `roi-${++seq}`;

beforeEach(() => {
  annotations.length = 0;
  sliceLoaded = true;
});

describe("計算とキャッシュ", () => {
  it("形から統計を出し、キャッシュに載せる", () => {
    const id = uid();
    annotations.push(rect(id, 4, 4, 14, 14));
    const r = computeRoiStatsNow(id)!;
    expect(r.geometry.areaMm2).toBeCloseTo(25, 6); // 100 px² × 0.25
    expect(r.values?.mean).toBeCloseTo(70, 6);
    expect(getRoiStats(id)).toBe(r);
  });

  it("形を変えたら作り直す（annotation.invalidated に頼らない）", () => {
    // 各ツールは自前の統計計算のあと invalidated を false へ戻すので、こちらが見る前に消える。
    const id = uid();
    const ann = rect(id, 4, 4, 14, 14);
    annotations.push(ann);
    const first = computeRoiStatsNow(id)!;
    ann.data.handles.points[2] = [24, 24, 0];
    ann.data.handles.points[1] = [24, 4, 0];
    ann.data.handles.points[3] = [4, 24, 0];
    const second = computeRoiStatsNow(id)!;
    expect(second).not.toBe(first);
    expect(second.geometry.areaMm2).toBeCloseTo(100, 6); // 20×20 px² × 0.25
  });

  it("形が同じならキャッシュを返す（描画のたびに計算し直さない）", () => {
    const id = uid();
    annotations.push(rect(id, 4, 4, 14, 14));
    expect(computeRoiStatsNow(id)).toBe(computeRoiStatsNow(id));
  });

  it("🔴 画素を読めなかった結果は確定扱いにしない（後で載っても出ない、を防ぐ）", async () => {
    // 署名は頂点から作るので、あとで画像が載っても署名は変わらない。
    // ここでキャッシュを確定にすると、その ROI は二度と統計が出ない。
    const id = uid();
    annotations.push(rect(id, 4, 4, 14, 14));
    sliceLoaded = false;
    const miss = computeRoiStatsNow(id)!;
    expect(miss.values).toBeUndefined();
    expect(miss.warnings).toContain("no-pixels");

    sliceLoaded = true;
    const hit = await computeRoiStatsAsync(id);
    expect(hit?.values?.mean).toBeCloseTo(70, 6);
  });

  it("校正が変われば作り直す（古い統計を持ち回らない）", () => {
    const id = uid();
    annotations.push(rect(id, 4, 4, 14, 14));
    const first = computeRoiStatsNow(id)!;
    invalidateAllRoiStats();
    expect(computeRoiStatsNow(id)).not.toBe(first);
  });

  it("存在しない ROI では undefined", () => {
    expect(computeRoiStatsNow("nope")).toBeUndefined();
  });

  it("詳細（ヒストグラム）は求められたときだけ作る", async () => {
    const id = uid();
    annotations.push(rect(id, 4, 4, 14, 14));
    expect(computeRoiStatsNow(id)!.histogram).toBeUndefined();
    const detailed = await computeRoiStatsAsync(id, { withHistogram: true });
    expect(detailed?.histogram?.totalCount).toBe(100);
  });
});
