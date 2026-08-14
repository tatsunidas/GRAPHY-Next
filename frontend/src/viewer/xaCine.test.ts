import { describe, expect, it, vi } from "vitest";

// Cornerstone のローダはここでは使わない（純関数だけを検証する）。
vi.mock("@cornerstonejs/dicom-image-loader", () => ({
  internal: { xhrRequest: vi.fn() },
  wadouri: { dataSetCacheManager: { isLoaded: vi.fn(), load: vi.fn(), get: vi.fn() } },
}));

const {
  DEFAULT_XA_FPS,
  cineDurationMs,
  frameAtElapsed,
  frameStartTimesMs,
  resolveXaFps,
} = await import("./xaCine");

/**
 * XA シネの時間軸（fw/angio-design.md §5.4）。
 *
 * <p>ここがずれると「実時間 1.0x のはずが速い/遅い」「フレームが 1 枚ずれる」という、
 * 目視では気づきにくい形で壊れる。動画 P4 で同種の事故（フレーム f の統計が f−1）を踏んでいる。
 */
describe("resolveXaFps — 優先順位", () => {
  it("FrameTimeVector が最優先（平均間隔から fps）", () => {
    // 4 フレーム。先頭要素は「1 フレーム目までの時間」なので増分としては使わない。
    const r = resolveXaFps({ numberOfFrames: 4, frameTimeVectorMs: [0, 100, 100, 100], frameTimeMs: 50 });
    expect(r.source).toBe("frameTimeVector");
    expect(r.fps).toBeCloseTo(10, 6);
  });

  it("FrameTimeVector が無ければ FrameTime", () => {
    const r = resolveXaFps({ numberOfFrames: 10, frameTimeMs: 33.3333, cineRate: 15 });
    expect(r.source).toBe("frameTime");
    expect(r.fps).toBeCloseTo(30, 2);
  });

  it("FrameTime が無ければ CineRate", () => {
    const r = resolveXaFps({ numberOfFrames: 10, cineRate: 12.5, recommendedDisplayFrameRate: 25 });
    expect(r.source).toBe("cineRate");
    expect(r.fps).toBe(12.5);
  });

  it("CineRate も無ければ RecommendedDisplayFrameRate", () => {
    const r = resolveXaFps({ numberOfFrames: 10, recommendedDisplayFrameRate: 25 });
    expect(r.source).toBe("recommendedDisplayFrameRate");
    expect(r.fps).toBe(25);
  });

  it("どれも無ければ既定 15fps", () => {
    const r = resolveXaFps({ numberOfFrames: 10 });
    expect(r.source).toBe("default");
    expect(r.fps).toBe(DEFAULT_XA_FPS);
  });

  it("0 や負の値は「無い」と同じ扱い（0 除算・逆再生を作らない）", () => {
    const r = resolveXaFps({ numberOfFrames: 10, frameTimeMs: 0, cineRate: -5, recommendedDisplayFrameRate: 20 });
    expect(r.source).toBe("recommendedDisplayFrameRate");
    expect(r.fps).toBe(20);
  });

  it("要素数が足りない FrameTimeVector は無視する（壊れたタグで再生を壊さない）", () => {
    const r = resolveXaFps({ numberOfFrames: 10, frameTimeVectorMs: [0, 100], frameTimeMs: 40 });
    expect(r.source).toBe("frameTime");
  });
});

describe("frameStartTimesMs — 各フレームの開始時刻", () => {
  it("等間隔（FrameTime 由来）", () => {
    const times = frameStartTimesMs({ numberOfFrames: 4, frameTimeMs: 100 });
    expect(times).toEqual([0, 100, 200, 300]);
  });

  it("可変間隔（FrameTimeVector 由来）は増分を積み上げる", () => {
    const times = frameStartTimesMs({ numberOfFrames: 4, frameTimeVectorMs: [0, 100, 50, 200] });
    expect(times).toEqual([0, 100, 150, 350]);
  });

  it("フレーム 1 枚でも壊れない", () => {
    expect(frameStartTimesMs({ numberOfFrames: 1, frameTimeMs: 100 })).toEqual([0]);
  });

  it("総時間は最終フレームの表示時間も含む", () => {
    expect(cineDurationMs({ numberOfFrames: 4, frameTimeMs: 100 })).toBe(400);
  });
});

describe("frameAtElapsed — 経過時刻 → フレーム", () => {
  const src = { numberOfFrames: 4, frameTimeMs: 100 };
  const times = frameStartTimesMs(src);
  const total = cineDurationMs(src);

  it("境界ちょうどは次のフレームに入る", () => {
    expect(frameAtElapsed(times, total, 0, true)).toBe(0);
    expect(frameAtElapsed(times, total, 99, true)).toBe(0);
    expect(frameAtElapsed(times, total, 100, true)).toBe(1);
    expect(frameAtElapsed(times, total, 350, true)).toBe(3);
  });

  it("ループ時は総時間で折り返す", () => {
    expect(frameAtElapsed(times, total, 400, true)).toBe(0);
    expect(frameAtElapsed(times, total, 550, true)).toBe(1);
  });

  it("ループしない時は最終フレームで止まる", () => {
    expect(frameAtElapsed(times, total, 100000, false)).toBe(3);
  });

  it("負の経過時刻でも先頭に丸める", () => {
    expect(frameAtElapsed(times, total, -50, false)).toBe(0);
  });

  it("可変間隔でも正しいフレームを引く", () => {
    const vsrc = { numberOfFrames: 4, frameTimeVectorMs: [0, 100, 50, 200] };
    const vt = frameStartTimesMs(vsrc); // [0, 100, 150, 350]
    const vtotal = cineDurationMs(vsrc);
    expect(frameAtElapsed(vt, vtotal, 149, true)).toBe(1);
    expect(frameAtElapsed(vt, vtotal, 150, true)).toBe(2);
    expect(frameAtElapsed(vt, vtotal, 349, true)).toBe(2);
    expect(frameAtElapsed(vt, vtotal, 350, true)).toBe(3);
  });

  it("描画が遅れても時間軸を保つ（フレームを飛ばす）", () => {
    // 250ms 分の遅延が起きた ＝ フレーム 0 の次は 2（1 を飛ばす）。伸ばさない。
    expect(frameAtElapsed(times, total, 250, true)).toBe(2);
  });
});
