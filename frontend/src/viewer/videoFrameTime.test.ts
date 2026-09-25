import { describe, expect, it } from "vitest";
import { clampFrame, cornerstoneFrameOf, frameToSeekTime } from "./videoFrameTime";

/** ブラウザが時刻 t で描くフレーム（[ (n-1)/fps, n/fps ) を含むもの）。 */
const drawnFrameAt = (t: number, fps: number) => Math.floor(t * fps + 1e-9) + 1;

describe("videoFrameTime（動画のフレーム送り）", () => {
  for (const [name, fps, frames] of [
    ["US 29.97fps・2052 フレーム（K12）", 29.97, 2052],
    ["US 29.97fps・10260 フレーム", 29.97002997002997, 10260],
    ["25fps", 25, 4958],
    ["15fps（検査のフィクスチャ）", 15, 30],
  ] as const) {
    it(`${name}: 全フレームで、描かれる絵と Cornerstone の番号が n に一致する`, () => {
      const duration = frames / fps;
      const bad: number[] = [];
      for (let n = 1; n <= frames; n++) {
        const t = frameToSeekTime(n, fps, duration);
        if (drawnFrameAt(t, fps) !== n || cornerstoneFrameOf(t, fps) !== n) bad.push(n);
      }
      expect(bad).toEqual([]);
    });
  }

  it("境目へのシーク（Cornerstone の setFrameNumber と同じ）は、描かれる絵が 1 つ前になることがある", () => {
    // これが「本当に 1 フレームずつ進んでいるのか分からない」の原因（直す前の挙動の記録）
    const fps = 29.97;
    let behind = 0;
    for (let n = 2; n <= 2052; n++) {
      const t = (n - 1) / fps;
      if (Math.floor(t * fps) + 1 !== n) behind++;
    }
    expect(behind).toBeGreaterThan(0);
  });

  it("最終フレームは duration を越えない", () => {
    const fps = 15;
    const duration = 30 / fps;
    expect(frameToSeekTime(30, fps, duration)).toBeLessThan(duration);
  });

  it("clampFrame は 1..total に収める", () => {
    expect(clampFrame(0, 30)).toBe(1);
    expect(clampFrame(31, 30)).toBe(30);
    expect(clampFrame(12, 30)).toBe(12);
  });
});
