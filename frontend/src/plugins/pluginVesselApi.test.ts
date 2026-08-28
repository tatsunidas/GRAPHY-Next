/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * A7 の host API（H11 / H12）の検査。
 *
 * <p>🔴 一番守りたいのは「**壊れた入力を黙って落とさない**」こと。
 * 未知の区間・範囲外の添字を捨てて残りを採用すると、**ずれたまま色が乗る**——
 * 値が付いているぶん、誰も間違いに気付けない（H9 / H39 と同じ判断）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getVesselModel,
  listVesselModels,
  putVesselAnalysis,
  readVesselAnalysis,
  summarizeVesselModel,
  validateVesselAnalysis,
  weakestTier,
  type XaVesselAnalysisInput,
} from "./pluginVesselApi";
import {
  closeVesselModelChannel,
  registerVesselModel,
  type XaVesselModel,
} from "../viewer/xaVesselModelStore";

const PRODUCER = { id: "acme.ffr", name: "ACME FFR", version: "1.2.0" };

function makeModel(over: Partial<XaVesselModel> = {}): XaVesselModel {
  return {
    runId: "xa-qca3d:a|b",
    kind: "xa-qca3d",
    label: "3D QCA",
    segments: [
      {
        id: "main",
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
        diameterMm: [3, 2.1, 3],
        parentId: null,
      },
    ],
    calibration: {
      diameterCalibrated: true,
      sources: ["user-catheter", "user-catheter"],
      tiers: ["calibrated", "calibrated"],
      diameterMethod: "densitometric",
    },
    provenance: {
      studyUid: "1.2.3",
      seriesUids: ["1.2.3.4", "1.2.3.5"],
      sopUids: ["1.2.3.4.1", "1.2.3.5.1"],
      angles: [
        [30, 0],
        [-30, 20],
      ],
      angleCorrected: true,
      visibleFractions: [0.9, 0.88],
      anchorReprojectionPx: 0.8,
      separationDeg: 62,
    },
    at: 1000,
    ...over,
  };
}

const OK: XaVesselAnalysisInput = {
  kind: "ffr",
  label: "FFR",
  range: [0.5, 1],
  perPoint: [
    { segmentId: "main", index: 0, value: 0.97 },
    { segmentId: "main", index: 2, value: 0.72 },
  ],
};

beforeEach(() => {
  registerVesselModel(makeModel());
});
afterEach(() => {
  closeVesselModelChannel();
});

describe("weakestTier", () => {
  it("1 方向でも近似なら近似、未校正が混ざれば未校正", () => {
    expect(weakestTier(["calibrated", "calibrated"])).toBe("calibrated");
    expect(weakestTier(["calibrated", "approximate"])).toBe("approximate");
    expect(weakestTier(["approximate", "uncalibrated"])).toBe("uncalibrated");
  });

  it("空は未校正（分からないものを calibrated と言わない）", () => {
    expect(weakestTier([])).toBe("uncalibrated");
  });
});

describe("H11 getVesselModel / listVesselModels", () => {
  it("runId を省略すると最新を返す", () => {
    registerVesselModel(makeModel({ runId: "newer", label: "newer", at: 2000 }));
    expect(getVesselModel()?.runId).toBe("newer");
    expect(getVesselModel("xa-qca3d:a|b")?.label).toBe("3D QCA");
  });

  it("知らない runId は null（適当に代わりを返さない）", () => {
    expect(getVesselModel("nope")).toBeNull();
  });

  it("一覧は点列を含まない要約（重い点列を選ぶ前に配らない）", () => {
    const [s] = listVesselModels();
    expect(s.pointCount).toBe(3);
    expect(s.segmentCount).toBe(1);
    expect(s.diameterCalibrated).toBe(true);
    expect(Object.keys(s)).not.toContain("segments");
  });

  it("要約の tier は最も弱い方向に合わせる", () => {
    const m = makeModel({ calibration: { ...makeModel().calibration, tiers: ["calibrated", "approximate"] } });
    expect(summarizeVesselModel(m).tier).toBe("approximate");
  });
});

describe("H12 validateVesselAnalysis", () => {
  it("正しい入力は通る", () => {
    expect(validateVesselAnalysis(makeModel(), OK)).toBeNull();
  });

  it("モデルが無ければ拒否", () => {
    expect(validateVesselAnalysis(null, OK)).toMatch(/not found/);
  });

  it("未知の区間は拒否（捨てて残りを採用しない）", () => {
    const bad = { ...OK, perPoint: [{ segmentId: "side", index: 0, value: 0.9 }] };
    expect(validateVesselAnalysis(makeModel(), bad)).toMatch(/unknown segmentId/);
  });

  it("範囲外の添字は拒否（ずれたまま色を乗せない）", () => {
    const bad = { ...OK, perPoint: [{ segmentId: "main", index: 3, value: 0.9 }] };
    expect(validateVesselAnalysis(makeModel(), bad)).toMatch(/index out of range/);
  });

  it("非有限の値は拒否", () => {
    const bad = { ...OK, perPoint: [{ segmentId: "main", index: 0, value: Number.NaN }] };
    expect(validateVesselAnalysis(makeModel(), bad)).toMatch(/finite/);
  });

  it("退化した範囲は拒否（全点が同じ色になる）", () => {
    expect(validateVesselAnalysis(makeModel(), { ...OK, range: [1, 1] })).toMatch(/min < max/);
  });

  it("空の perPoint・空の label・未知の kind は拒否", () => {
    expect(validateVesselAnalysis(makeModel(), { ...OK, perPoint: [] })).toMatch(/at least one/);
    expect(validateVesselAnalysis(makeModel(), { ...OK, label: "  " })).toMatch(/label/);
    expect(
      validateVesselAnalysis(makeModel(), { ...OK, kind: "bogus" as never }),
    ).toMatch(/unknown kind/);
  });
});

describe("H12 putVesselAnalysis", () => {
  it("出自は host が入れる（プラグインに名乗らせない）", () => {
    expect(putVesselAnalysis("xa-qca3d:a|b", OK, PRODUCER)).toEqual({ ok: true });
    const a = readVesselAnalysis("xa-qca3d:a|b");
    expect(a?.source).toEqual({ pluginId: "acme.ffr", pluginName: "ACME FFR", version: "1.2.0" });
  });

  it("拒否したときは何も書かない（半端に入った状態を作らない）", () => {
    const bad = { ...OK, perPoint: [{ segmentId: "main", index: 99, value: 0.9 }] };
    const r = putVesselAnalysis("xa-qca3d:a|b", bad, PRODUCER);
    expect(r.ok).toBe(false);
    expect(readVesselAnalysis("xa-qca3d:a|b")).toBeNull();
  });

  it("空白だけの disclaimer は持たない（空文字を表示しない）", () => {
    putVesselAnalysis("xa-qca3d:a|b", { ...OK, disclaimer: "   " }, PRODUCER);
    expect(readVesselAnalysis("xa-qca3d:a|b")?.disclaimer).toBeUndefined();
  });

  it("perPoint の参照を持ち回らない（後から書き換えられて画面が黙って変わるのを防ぐ）", () => {
    const input: XaVesselAnalysisInput = { ...OK, perPoint: [{ segmentId: "main", index: 0, value: 0.9 }] };
    putVesselAnalysis("xa-qca3d:a|b", input, PRODUCER);
    input.perPoint[0].value = 0.1;
    expect(readVesselAnalysis("xa-qca3d:a|b")?.perPoint[0].value).toBe(0.9);
  });

  it("モデルを登録し直すと、その runId の古い解析値は捨てられる（別の血管の色が残らない）", () => {
    putVesselAnalysis("xa-qca3d:a|b", OK, PRODUCER);
    expect(readVesselAnalysis("xa-qca3d:a|b")).not.toBeNull();
    registerVesselModel(makeModel({ at: 3000 }));
    expect(readVesselAnalysis("xa-qca3d:a|b")).toBeNull();
  });
});
