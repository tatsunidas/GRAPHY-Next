import { describe, expect, it } from "vitest";
import { frameStartTimesMs, isUniformFrameTime, resolveXaFps, type XaCineSource } from "../viewer/xaCineTiming";
import { cineOfSource } from "./xaSeriesCine";

const src = (over: Partial<XaCineSource> = {}): XaCineSource => ({ numberOfFrames: 5, frameTimeMs: 66.667, frameTimeVectorMs: null, cineRate: null, recommendedDisplayFrameRate: null, ...over });

describe("cineOfSource（readXaSeries の cine）", () => {
  it("H40 getXaCine と同じ決め方（fps・出自・各フレームの開始時刻・一様か）", () => {
    const s = src();
    const c = cineOfSource(s)!;
    const f = resolveXaFps(s);
    expect(c.fps).toBe(f.fps);
    expect(c.fpsSource).toBe(f.source);
    expect(c.frameStartTimesMs).toEqual(frameStartTimesMs(s));
    expect(c.uniform).toBe(isUniformFrameTime(s));
    expect(c.numberOfFrames).toBe(5);
    expect(c.fpsSource).toBe("frameTime");
    expect(c.fps).toBeCloseTo(15, 1);
  });
  it("可変レート（FrameTimeVector）は uniform=false で、時刻の差が一定でない", () => {
    const c = cineOfSource(src({ frameTimeMs: null, frameTimeVectorMs: [0, 60, 70, 100, 150] }))!;
    expect(c.fpsSource).toBe("frameTimeVector");
    expect(c.uniform).toBe(false);
    const d = c.frameStartTimesMs.slice(1).map((t, i) => t - c.frameStartTimesMs[i]);
    expect(new Set(d.map((x) => x.toFixed(3))).size).toBeGreaterThan(1);
  });
  it("★負例: どのタグも無いと出自は default（測定値ではない）。材料が無ければ null（既定値で埋めない）", () => {
    expect(cineOfSource(src({ frameTimeMs: null }))!.fpsSource).toBe("default");
    expect(cineOfSource(null)).toBeNull();
  });
});
