/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  combineVolumes, countFinite, describeCalc, finiteMinOrNull, initialCalcOp, planCalcStorage,
} from "./fusionCalc";
import { buildDerivedVolumeRequest, floatFramePixelsBase64 } from "./derivedVolumeSave";
import { axisGrid } from "./gridResample";
import { makeVolume } from "./regGeometry";

const bg = Float32Array.from([10, -20, 5, NaN, 0]);
const fg = Float32Array.from([4, 30, NaN, 7, 0]);

describe("combineVolumes", () => {
  it("符号付き差分は 前景 − 背景（符号を入れ替えた値とは一致しない）", () => {
    const d = combineVolumes(bg, fg, "diff");
    expect(Array.from(d.slice(0, 2))).toEqual([-6, 50]);
    // 負例: 背景 − 前景 の値ではない
    expect(d[0]).not.toBe(6);
  });
  it("絶対値差分は符号を落とす", () => {
    expect(Array.from(combineVolumes(bg, fg, "absdiff").slice(0, 2))).toEqual([6, 50]);
  });
  it("乗算は前景 × 背景", () => {
    expect(Array.from(combineVolumes(bg, fg, "mult").slice(0, 2))).toEqual([40, -600]);
  });
  it("どちらかが NaN の画素は NaN（0 で埋めない）、0 と 0 は 0", () => {
    for (const op of ["diff", "absdiff", "mult"] as const) {
      const r = combineVolumes(bg, fg, op);
      expect(Number.isNaN(r[2])).toBe(true);
      expect(Number.isNaN(r[3])).toBe(true);
      expect(r[4]).toBe(0);
    }
  });
  it("格子が違えば拒否する", () => {
    expect(() => combineVolumes(new Float32Array(2), new Float32Array(3), "diff")).toThrow();
  });
  it("重なりの数と最小値は有限な画素だけで数える", () => {
    const r = combineVolumes(bg, fg, "diff");
    expect(countFinite(r)).toBe(3);
    expect(finiteMinOrNull(r)).toBe(-6);
    expect(finiteMinOrNull(Float32Array.from([NaN]))).toBeNull();
  });
});

describe("planCalcStorage", () => {
  const ct = { unit: "HU", modality: "CT" };
  const pet = { unit: "SUVbw", modality: "PT" };
  it("同じモダリティ・単位の差分は元のモダリティのまま", () => {
    expect(planCalcStorage("diff", ct, ct).kind).toBe("derived");
    expect(planCalcStorage("absdiff", pet, pet).kind).toBe("derived");
  });
  it("乗算は常に Parametric Map（同じ単位でも）", () => {
    const p = planCalcStorage("mult", ct, ct);
    expect(p.kind).toBe("parametric");
    if (p.kind === "parametric") {
      expect(p.unitCode).not.toBe("1");
      expect(p.unitMeaning).toBe("HU x HU");
    }
  });
  it("単位の違う差分は Parametric Map にして単位を明記する", () => {
    const p = planCalcStorage("diff", ct, pet); // 前景 PET、背景 CT
    expect(p.kind).toBe("parametric");
    if (p.kind === "parametric") expect(p.unitMeaning).toBe("SUVbw - HU");
  });
  it("モダリティが違えば単位が同じ空でも元のモダリティでは持たない", () => {
    expect(planCalcStorage("diff", { unit: "", modality: "MR" }, { unit: "", modality: "NM" }).kind).toBe("parametric");
  });
});

describe("initialCalcOp / describeCalc", () => {
  it("乗算(表示)は乗算、それ以外は差分で始める", () => {
    expect(initialCalcOp("multiply")).toBe("mult");
    expect(initialCalcOp("difference")).toBe("diff");
    expect(initialCalcOp("normal")).toBe("diff");
  });
  it("式に前景・背景の名前を入れる", () => {
    expect(describeCalc("diff", "PET", "CT")).toContain("FG - BG; FG=PET, BG=CT");
  });
});

describe("Parametric Map の要求", () => {
  const src = makeVolume(new Float32Array(2 * 2 * 3), [2, 2, 3], [1, 0, 0, 0, 1, 0], [0, 0, 0], 1, 1, [0, 0, 2]);
  const grid = axisGrid(src, [1, 1, 2]);
  const data = Float32Array.from([1.5, -2.25, NaN, 1e6, 0, 3, 4, 5, 6, 7, 8, 9]);

  it("値を Float32 のまま運び、NaN も保つ。Rescale は恒等で PixelPadding・SUV 割りを使わない", () => {
    const req = buildDerivedVolumeRequest({
      grid, data, studyUid: "S", seriesUid: "E", seriesDescription: "d", derivationDescription: "x",
      suvScale: 2.5, background: NaN,
      parametricMap: { label: "FUSION_MULT", explanation: "e", unitCode: "{FUSION_PRODUCT}", unitMeaning: "HU x SUVbw" },
    });
    expect(req.parametricMap?.unitMeaning).toBe("HU x SUVbw");
    expect(req.rescaleSlope).toBe(1);
    expect(req.rescaleIntercept).toBe(0);
    expect(req.pixelPaddingValue).toBeNull();
    const bin = atob(req.frames[0].pixels);
    expect(bin.length).toBe(2 * 2 * 4);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const back = new Float32Array(u8.buffer);
    expect(back[0]).toBe(1.5);
    expect(back[1]).toBe(-2.25);
    expect(Number.isNaN(back[2])).toBe(true);
    expect(back[3]).toBe(1e6); // SUV 乗数で割られていない
  });

  it("Float のバイト列はリトルエンディアン", () => {
    const b = atob(floatFramePixelsBase64(Float32Array.from([1])));
    expect(Array.from(b, (c) => c.charCodeAt(0))).toEqual([0x00, 0x00, 0x80, 0x3f]);
  });

  it("通常の派生では parametricMap は null", () => {
    const req = buildDerivedVolumeRequest({
      grid, data: Float32Array.from(data, (v) => (Number.isFinite(v) ? v : 0)),
      studyUid: "S", seriesUid: "E", seriesDescription: "d", derivationDescription: "x", background: -1000,
    });
    expect(req.parametricMap).toBeNull();
  });
});
