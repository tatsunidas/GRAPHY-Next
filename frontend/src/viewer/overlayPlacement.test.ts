/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * オーバーレイ配置のテスト。
 *
 * <p>`base` を回転・反転させたときにオーバーレイが追従するかは、長らく
 * 「軸並行 BBox なので厳密でない」という既知の限界だった（`fw/HANDOFF.md`）。
 * 手動位置合わせが入って、ズレが**調整量由来か未追従由来か**切り分けられなく
 * なったため直したもの。ここでは配置の CSS を数値で固定する。
 */
import { describe, it, expect } from "vitest";
import { overlayPlacement, type ImageRect } from "./overlayPlacement";

/** 画像の 3 隅（canvas 座標）から `ImageRect` を作る（`computeImageRect` と同じ規則）。 */
function rectFrom(tl: [number, number], tr: [number, number], bl: [number, number]): ImageRect {
  const ux = tr[0] - tl[0], uy = tr[1] - tl[1];
  const vx = bl[0] - tl[0], vy = bl[1] - tl[1];
  const width = Math.hypot(ux, uy);
  const height = Math.hypot(vx, vy);
  return {
    left: tl[0], top: tl[1], width, height,
    linear: [ux / width, uy / width, vx / height, vy / height],
  };
}

/** 配置 CSS を使って、要素ローカル座標 → canvas 座標 を再現する。 */
function place(rect: ImageRect, x: number, y: number): [number, number] {
  const css = overlayPlacement(rect);
  const m = /matrix\(([^)]+)\)/.exec(String(css.transform))![1].split(",").map(Number);
  return [
    Number(css.left) + m[0] * x + m[2] * y,
    Number(css.top) + m[1] * x + m[3] * y,
  ];
}

describe("overlayPlacement", () => {
  it("回転も反転も無ければ恒等（従来と完全に同じ配置）", () => {
    const rect = rectFrom([10, 20], [110, 20], [10, 70]);
    expect(rect.linear).toEqual([1, 0, 0, 1]);
    const css = overlayPlacement(rect);
    expect(css.left).toBe(10);
    expect(css.top).toBe(20);
    expect(css.width).toBe(100);
    expect(css.height).toBe(50);
    expect(css.transformOrigin).toBe("0 0");
  });

  it("★90° 回転に追従する", () => {
    // 画像の +列方向が canvas の下向き、+行方向が canvas の左向き（時計回り 90°）。
    const tl: [number, number] = [200, 10];
    const tr: [number, number] = [200, 110]; // 列方向 = +y
    const bl: [number, number] = [150, 10];  // 行方向 = −x
    const rect = rectFrom(tl, tr, bl);
    // 4 隅が画像の実際の位置に一致すること。
    expect(place(rect, 0, 0)).toEqual([200, 10]);
    expect(place(rect, rect.width, 0)[0]).toBeCloseTo(200, 6);
    expect(place(rect, rect.width, 0)[1]).toBeCloseTo(110, 6);
    expect(place(rect, 0, rect.height)[0]).toBeCloseTo(150, 6);
    expect(place(rect, 0, rect.height)[1]).toBeCloseTo(10, 6);
  });

  it("★左右反転に追従する（従来は形が同じなので見逃していた）", () => {
    // 反転すると列方向が −x になる。BBox は同じなので、矩形だけでは区別できない。
    const rect = rectFrom([110, 20], [10, 20], [110, 70]);
    expect(rect.linear[0]).toBeCloseTo(-1, 9);
    expect(place(rect, 0, 0)).toEqual([110, 20]);
    expect(place(rect, rect.width, 0)[0]).toBeCloseTo(10, 6);
  });

  it("任意角の回転でも 3 隅が一致する", () => {
    const th = (37 * Math.PI) / 180;
    const c = Math.cos(th), s = Math.sin(th);
    const w = 80, h = 40;
    const tl: [number, number] = [5, 7];
    const tr: [number, number] = [5 + w * c, 7 + w * s];
    const bl: [number, number] = [5 - h * s, 7 + h * c];
    const rect = rectFrom(tl, tr, bl);
    expect(rect.width).toBeCloseTo(w, 9);
    expect(rect.height).toBeCloseTo(h, 9);
    const p1 = place(rect, rect.width, 0);
    expect(p1[0]).toBeCloseTo(tr[0], 6);
    expect(p1[1]).toBeCloseTo(tr[1], 6);
    const p2 = place(rect, 0, rect.height);
    expect(p2[0]).toBeCloseTo(bl[0], 6);
    expect(p2[1]).toBeCloseTo(bl[1], 6);
  });

  it("zoom（拡大）は width/height に入り、線形部は恒等のまま", () => {
    const rect = rectFrom([0, 0], [200, 0], [0, 100]);
    expect(rect.linear).toEqual([1, 0, 0, 1]);
    expect(rect.width).toBe(200);
    expect(rect.height).toBe(100);
  });
});
