/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { partSpan, planConcatResample } from "./concatPlan";
import type { ConcatPart } from "./virtualLayout";

/** 法線 +z・start mm から step mm 間隔で n 枚の 1 本。面内は rows×columns・間隔 ps mm・原点 (ox, oy)。 */
function part(o: {
  name: string; start: number; n: number; step?: number; rows?: number; columns?: number; ps?: number;
  ox?: number; oy?: number; posOf?: (z: number) => number; hasImage?: (c: number, t: number, z: number) => boolean;
}): ConcatPart {
  const step = o.step ?? 1;
  const pos = o.posOf ?? ((z: number) => o.start + z * step);
  return {
    study: "st",
    series: o.name,
    layout: {
      nZ: o.n, nC: 1, nT: 1,
      zStack: () => Array.from({ length: o.n }, (_, z) => `${o.name}:${z}`),
      ippAt: (z) => [o.ox ?? 0, o.oy ?? 0, pos(z)],
      normal: [0, 0, 1],
      hasImage: o.hasImage,
    },
    iop: [1, 0, 0, 0, 1, 0],
    pixelSpacing: [o.ps ?? 1, o.ps ?? 1],
    rows: o.rows ?? 64,
    columns: o.columns ?? 64,
    patientId: "P1",
    frameOfReferenceUid: "FOR1",
    modality: "CT",
  };
}

describe("planConcatResample", () => {
  // 小さい視野 64 px・1 mm（z 0..99）と 4 倍の視野 128 px・2 mm（z 90..199）。
  const small = () => part({ name: "A", start: 0, n: 100 });
  const big = () => part({ name: "D", start: 90, n: 110, rows: 128, columns: 128, ps: 2 });

  it("共通格子は細かい側の間隔、範囲は視野の和集合、出力と入力の大きさを返す", () => {
    const r = planConcatResample([small(), big()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { grid, outBytes, inBytes } = r.plan;
    expect(grid.spacing).toEqual([1, 1, 1]);
    // 大きい視野の中心は 0..254 mm（128 画素 × 2 mm）なので 255 画素、奥行きは 0..199 の 200 枚
    expect(grid.dims).toEqual([255, 255, 200]);
    expect(outBytes).toBe(255 * 255 * 200 * 4);
    expect(inBytes).toBe((64 * 64 * 100 + 128 * 128 * 110) * 4);
    expect(grid.inflation).toBeCloseTo((255 * 255 * 200) / (64 * 64 * 100 + 128 * 128 * 110), 6);
  });

  it("入力の順に依らず同じ格子（奥に置いた方が先でも）", () => {
    const a = planConcatResample([small(), big()]);
    const b = planConcatResample([big(), small()]);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(b.plan.grid.dims).toEqual(a.plan.grid.dims);
  });

  it("スライスが降順に並んだシリーズでも、昇順の先頭から数える", () => {
    const desc = part({ name: "A", start: 0, n: 100, posOf: (z) => 99 - z });
    const s = partSpan(desc);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.ipp0).toEqual([0, 0, 0]);
      expect(s.step).toEqual([0, 0, 1]);
    }
  });

  it("シリーズの中に欠けた位置（ブランク）があれば断る（黙って最小値で埋めない）", () => {
    const gappy = part({ name: "A", start: 0, n: 100, hasImage: (_c, _t, z) => z !== 50 });
    expect(planConcatResample([gappy, big()])).toEqual({ ok: false, reason: "partGaps", part: 0 });
  });

  it("シリーズの中のスライス間隔が不均一なら断る。1% 以内なら通す", () => {
    const uneven = part({ name: "A", start: 0, n: 100, posOf: (z) => z + (z >= 50 ? 0.5 : 0) });
    expect(planConcatResample([uneven, big()])).toEqual({ ok: false, reason: "irregular", part: 0 });
    const jitter = part({ name: "A", start: 0, n: 100, posOf: (z) => z + (z % 2 ? 0.005 : 0) });
    expect(planConcatResample([jitter, big()]).ok).toBe(true);
  });

  it("スライスが 1 枚だけ（奥行きの向きが決まらない）なら断る", () => {
    expect(planConcatResample([part({ name: "A", start: 0, n: 1 }), big()])).toEqual({ ok: false, reason: "single", part: 0 });
  });

  it("面内の位置がずれた同じ大きさの格子でも見積もれる（共通格子が視野の和集合に広がる）", () => {
    const shifted = part({ name: "B", start: 90, n: 110, ox: 32, oy: 0 });
    const r = planConcatResample([small(), shifted]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.grid.dims).toEqual([96, 64, 200]); // x は 0..95
  });
});
