/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { buildRoiPixelDump, roiPixelDumpBlobText, roiPixelDumpToCsv } from "./roiPixelDump";
import { buildRoiMesh, computeRoiStatsFrom } from "./roiStats";
import type { PlaneGeometry } from "./imageCoords";
import type { PointPx } from "./roiRead";

const W = 24;
const H = 20;
// 正規直交の斜め IOP（R: 列 index 増加の向き、CC: 行 index 増加の向き。R·CC = 0）。
const R: [number, number, number] = [0.8, 0.6, 0];
const C0: [number, number, number] = [-0.6 * 0.8, 0.8 * 0.8, 0.6];
const cn = Math.hypot(...C0);
const CC: [number, number, number] = [C0[0] / cn, C0[1] / cn, C0[2] / cn];
const IPP: [number, number, number] = [-120.5, 33.25, 77.125];
const ROW_SP = 0.9;
const COL_SP = 0.6;
const plane: PlaneGeometry = {
  imagePositionPatient: IPP,
  rowCosines: R,
  columnCosines: CC,
  rowPixelSpacing: ROW_SP,
  columnPixelSpacing: COL_SP,
};

function image(): Float32Array {
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = ((i * 37) % 101) - 30;
  return a;
}
const rect: PointPx[] = [
  [4, 3],
  [15, 3],
  [15, 12],
  [4, 12],
];
const meta = { label: "a,b", roiUid: "u1", imageId: "wadouri:x", unit: "HU" };

function build(values: Float32Array, pl: PlaneGeometry | null) {
  const mesh = buildRoiMesh("RectangleROI", rect, undefined)!;
  const rows = buildRoiPixelDump({ kind: "area", mesh, slice: { values, width: W, height: H }, plane: pl });
  return { mesh, rows };
}

describe("座標", () => {
  it("全行の x/y/z が一次式 IPP+col·列間隔·rowCos+row·行間隔·colCos と 1e-6 mm で一致", () => {
    const { rows } = build(image(), plane);
    expect(rows!.length).toBeGreaterThan(0);
    for (const r of rows!) {
      const a = r.col * COL_SP;
      const b = r.row * ROW_SP;
      expect(Math.abs(r.x! - (IPP[0] + a * R[0] + b * CC[0]))).toBeLessThan(1e-6);
      expect(Math.abs(r.y! - (IPP[1] + a * R[1] + b * CC[1]))).toBeLessThan(1e-6);
      expect(Math.abs(r.z! - (IPP[2] + a * R[2] + b * CC[2]))).toBeLessThan(1e-6);
    }
  });

  it("負例: 行間隔と列間隔を入れ替えた式の値は少なくとも 1 行で 1e-6 mm を超えてずれる", () => {
    const { rows } = build(image(), plane);
    let maxd = 0;
    for (const r of rows!) {
      const a = r.col * ROW_SP; // 入れ替えた誤り
      const b = r.row * COL_SP;
      maxd = Math.max(
        maxd,
        Math.abs(r.x! - (IPP[0] + a * R[0] + b * CC[0])),
        Math.abs(r.y! - (IPP[1] + a * R[1] + b * CC[1])),
        Math.abs(r.z! - (IPP[2] + a * R[2] + b * CC[2])),
      );
    }
    expect(maxd).toBeGreaterThan(1e-6);
  });
});

describe("母集団（統計と同じ）", () => {
  const stats = (values: Float32Array) =>
    computeRoiStatsFrom({
      roiUid: "u1",
      tool: "RectangleROI",
      imageId: "x",
      pointsPx: rect,
      closed: undefined,
      slice: { values, width: W, height: H },
      unit: "HU",
      spacingX: COL_SP,
      spacingY: ROW_SP,
    });
  const meanOf = (rows: { value?: number }[]) => {
    const v = rows.filter((r) => r.value !== undefined).map((r) => r.value!);
    return v.reduce((s, x) => s + x, 0) / v.length;
  };

  it("行数＝sampleCount、値の平均＝values.mean（相対 1e-6）", () => {
    const v = image();
    const { rows } = build(v, plane);
    const st = stats(v);
    expect(rows!.length).toBe(st.geometry.sampleCount);
    const m = st.values!.mean;
    expect(Math.abs(meanOf(rows!) - m)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(m)));
  });

  it("負例: NaN を 1 つ入れても行数は変わらず、その行の値セルが空で、平均は一致し続ける", () => {
    const v = image();
    const base = build(v, plane).rows!.length;
    v[5 * W + 7] = NaN;
    const { rows } = build(v, plane);
    expect(rows!.length).toBe(base);
    const nanRow = rows!.find((r) => r.col === 7 && r.row === 5)!;
    expect(nanRow.value).toBeUndefined();
    const st = stats(v);
    expect(rows!.length).toBe(st.geometry.sampleCount);
    const m = st.values!.mean;
    expect(Math.abs(meanOf(rows!) - m)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(m)));
    // 値セル（imageId の直前）が空
    expect(roiPixelDumpToCsv([nanRow], meta).split("\r\n")[1]).toMatch(/,,wadouri:x$/);
  });
});

describe("幾何なし・点・線", () => {
  it("plane=null のとき x/y/z は空セル（0 ではない）で col/row と値は出る", () => {
    const v = image();
    const { rows } = build(v, null);
    for (const r of rows!) {
      expect(r.x).toBeUndefined();
      expect(r.y).toBeUndefined();
      expect(r.z).toBeUndefined();
      expect(r.value).toBe(v[r.row * W + r.col]);
    }
    const cells = roiPixelDumpToCsv(rows!, { ...meta, label: "L" }).split("\r\n")[1].split(",");
    expect(cells.slice(4, 7)).toEqual(["", "", ""]);
    expect(cells[2]).toBe(String(rows![0].col));
    expect(cells[7]).not.toBe("");
  });

  it("プローブは 1 行で、col/row が geometry.samplePx と一致（画像の外の点も端へ丸める）", () => {
    for (const p of [
      [6.2, 9.7],
      [-4, 50],
    ] as PointPx[]) {
      const v = image();
      const input = {
        roiUid: "p",
        tool: "Probe",
        imageId: "x",
        pointsPx: [p],
        closed: undefined,
        slice: { values: v, width: W, height: H },
        unit: "HU",
        spacingX: 1,
        spacingY: 1,
      };
      const st = computeRoiStatsFrom(input);
      expect(st.geometry.kind).toBe("point");
      const mesh = buildRoiMesh("Probe",[p], undefined)!;
      const rows = buildRoiPixelDump({ kind: "point", mesh, slice: input.slice, plane })!;
      expect(rows.length).toBe(1);
      expect([rows[0].col, rows[0].row]).toEqual(st.geometry.samplePx);
      expect(rows[0].value).toBe(v[rows[0].row * W + rows[0].col]);
    }
  });

  it("kind が line / none なら null", () => {
    const mesh = {
      pointsPx: [
        [1, 1],
        [8, 8],
      ] as PointPx[],
      closed: false,
    };
    const slice = { values: image(), width: W, height: H };
    expect(buildRoiPixelDump({ kind: "line", mesh, slice, plane })).toBeNull();
    expect(buildRoiPixelDump({ kind: "none", mesh, slice, plane })).toBeNull();
  });
});

describe("CSV", () => {
  it("BOM・CRLF・ラベルのエスケープ・単位が列名に入る", () => {
    const { rows } = build(image(), plane);
    const lines = roiPixelDumpToCsv(rows!, meta).split("\r\n");
    expect(lines[0]).toBe("label,roiUid,col,row,x[mm],y[mm],z[mm],value[HU],imageId");
    expect(lines[1].startsWith('"a,b",u1,')).toBe(true);
    expect(lines.length).toBe(rows!.length + 1);
    const blob = roiPixelDumpBlobText(rows!, meta);
    expect(blob.charCodeAt(0)).toBe(0xfeff);
    expect(blob.endsWith("\r\n")).toBe(true);
  });
});

describe("Fusion の背景を測ったときの記録", () => {
  it("負例: fusion が無ければ列は増えない／正例: あれば末尾に 3 列", () => {
    const rows = [{ col: 1, row: 2, value: 3 }];
    const base = roiPixelDumpToCsv(rows, meta).split("\r\n");
    expect(base[0].split(",")).not.toContain("measuredOn");
    const withF = roiPixelDumpToCsv(rows, { ...meta, fusion: { backgroundSeriesUid: "S1", foregroundLabel: "PET, \"early\"", blend: "difference" as const } }).split("\r\n");
    expect(withF[0].split(",").slice(-3)).toEqual(["measuredOn", "fusionBlend", "fusionForeground"]);
    expect(withF[1].endsWith(',background,difference,"PET, ""early"""')).toBe(true);
  });
});
