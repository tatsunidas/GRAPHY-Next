/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { computeRoiStats, timeSeriesToCsv, type TimeSeriesPoint } from "./videoRoiAnalysis";

/** bw*bh の RGBA バッファを作る。`pixel(px,py)` が [r,g,b]（a は 255 固定）。 */
function makeRgba(bw: number, bh: number, pixel: (px: number, py: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(bw * bh * 4);
  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      const i = (py * bw + px) * 4;
      const [r, g, b] = pixel(px, py);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

describe("computeRoiStats", () => {
  it("uniform rect: mean=value, min=max, sd=0", () => {
    const data = makeRgba(4, 3, () => [100, 150, 200]);
    const s = computeRoiStats(data, 4, 3, "rect");
    expect(s.nPixels).toBe(12);
    expect(s.meanR).toBeCloseTo(100, 6);
    expect(s.meanG).toBeCloseTo(150, 6);
    expect(s.meanB).toBeCloseTo(200, 6);
    const y = luma(100, 150, 200);
    expect(s.meanY).toBeCloseTo(y, 6);
    expect(s.minY).toBeCloseTo(y, 6);
    expect(s.maxY).toBeCloseTo(y, 6);
    expect(s.sdY).toBeCloseTo(0, 6);
  });

  it("two-value rect: exact mean/min/max/sd of luma", () => {
    // 2x1: 黒(luma 0) と 白(luma 255)。
    const data = makeRgba(2, 1, (px) => (px === 0 ? [0, 0, 0] : [255, 255, 255]));
    const s = computeRoiStats(data, 2, 1, "rect");
    expect(s.nPixels).toBe(2);
    expect(s.minY).toBeCloseTo(0, 6);
    expect(s.maxY).toBeCloseTo(255, 6);
    expect(s.meanY).toBeCloseTo(127.5, 6);
    // 母集団SD = sqrt((0^2+255^2)/2 - 127.5^2) = 127.5
    expect(s.sdY).toBeCloseTo(127.5, 6);
  });

  it("ellipse mask excludes corners (5x5 → 21 px inside)", () => {
    const data = makeRgba(5, 5, () => [100, 100, 100]);
    const s = computeRoiStats(data, 5, 5, "ellipse");
    expect(s.nPixels).toBe(21); // 5x5 の内接楕円に入る画素数
    expect(s.meanY).toBeCloseTo(luma(100, 100, 100), 6); // = 100
    expect(s.sdY).toBeCloseTo(0, 6);
  });

  it("single pixel: sd=0, min=max=mean", () => {
    const data = makeRgba(1, 1, () => [40, 40, 40]);
    const s = computeRoiStats(data, 1, 1, "rect");
    expect(s.nPixels).toBe(1);
    expect(s.minY).toBeCloseTo(40, 6);
    expect(s.maxY).toBeCloseTo(40, 6);
    expect(s.sdY).toBeCloseTo(0, 6);
  });
});

describe("timeSeriesToCsv", () => {
  it("header and row include min/max/sd luma columns", () => {
    const pts: TimeSeriesPoint[] = [
      {
        frame: 1,
        timeSec: 0,
        nPixels: 10,
        meanY: 100.1234,
        minY: 12.5,
        maxY: 200.25,
        sdY: 5.6789,
        meanR: 90.1,
        meanG: 100.2,
        meanB: 110.3,
      },
    ];
    const csv = timeSeriesToCsv(pts);
    const [header, row] = csv.trimEnd().split("\r\n");
    expect(header).toBe("frame,time_sec,n_pixels,mean_luma,min_luma,max_luma,sd_luma,mean_r,mean_g,mean_b");
    expect(row).toBe("1,0.0000,10,100.123,12.500,200.250,5.679,90.100,100.200,110.300");
  });
});
