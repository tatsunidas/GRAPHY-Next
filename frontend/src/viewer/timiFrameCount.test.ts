/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * この機能の心臓部は**換算**なので、テストはそこが厚い。
 * 特に「30fps でない撮影で換算せずに数字を出さない」「撮影レート不明なら数字を出さない」の
 * 2 つは、壊れても画面は普通に動いてしまう（数字が少し違うだけ）ので、ここでしか守れない。
 */
import { describe, expect, it, vi } from "vitest";

// ⚠️ `xaCine` 経由で Cornerstone のローダが読み込まれる。ここでは純関数だけを検証するので
//    偽物に差し替える（`xaCine.test.ts` と同じ作法）。
vi.mock("@cornerstonejs/dicom-image-loader", () => ({
  internal: { xhrRequest: vi.fn() },
  wadouri: { dataSetCacheManager: { isLoaded: vi.fn(), load: vi.fn(), get: vi.fn() } },
}));

const {
  arrivalCandidate,
  computeTimiFrameCount,
  ctfcForVessel,
  frameElapsedMs,
  isUniformFrameTime,
  meanInRect,
  TIMI_REFERENCE_FPS,
} = await import("./timiFrameCount");
type TimiVessel = import("./timiFrameCount").TimiVessel;
type XaCineSource = import("./xaCine").XaCineSource;

/** FrameTime だけを持つ等間隔の収集。 */
function cineAt(fps: number, frames = 100): XaCineSource {
  return { numberOfFrames: frames, frameTimeMs: 1000 / fps };
}

/** タグが 1 つも無い＝既定 15fps に落ちる収集。 */
function cineNoTags(frames = 100): XaCineSource {
  return { numberOfFrames: frames };
}

function run(cine: XaCineSource, start: number, end: number, vessel: TimiVessel = "rca") {
  return computeTimiFrameCount({ vessel, startFrame: start, endFrame: end, cine });
}

describe("computeTimiFrameCount — 30fps への換算", () => {
  it("ちょうど 30fps なら換算は恒等（生のフレーム差と一致）", () => {
    const r = run(cineAt(30), 10, 40)!;
    expect(r.frames).toBe(30);
    expect(r.tfc30!).toBeCloseTo(30, 6);
    expect(r.unit).toBe("frames@30fps");
    expect(r.warnings).not.toContain("rateNot30");
  });

  it("FrameTime 33ms（30.303fps）で 30 フレーム差 → 29.70", () => {
    const cine: XaCineSource = { numberOfFrames: 96, frameTimeMs: 33 };
    const r = run(cine, 10, 40)!;
    expect(r.fps).toBeCloseTo(1000 / 33, 6);
    expect(r.tfc30!).toBeCloseTo(29.7, 3);
    // 一様レートなら「フレーム差 × 30 / fps」と厳密に一致する。
    expect(r.tfc30!).toBeCloseTo((30 * TIMI_REFERENCE_FPS) / r.fps, 9);
  });

  it("🔴 15fps で 20 フレーム差 → 40.0（換算しないと 20 のまま）", () => {
    // この 1 本が「30fps でない撮影で換算せずに出さない」の番人。
    const r = run(cineAt(15), 5, 25)!;
    expect(r.frames).toBe(20);
    expect(r.tfc30!).toBeCloseTo(40, 6);
    expect(r.warnings).toContain("rateNot30");
  });

  it("🔴 撮影レートのタグが無ければ換算値を一切出さない（既定 15fps で割らない）", () => {
    const r = run(cineNoTags(), 5, 25)!;
    expect(r.fpsSource).toBe("default");
    expect(r.tfc30).toBeNull();
    expect(r.ctfc).toBeNull();
    expect(r.elapsedMs).toBeNull();
    expect(r.unit).toBe("frames");
    expect(r.warnings).toContain("fpsUnknown");
    // 生のフレーム差だけは出る（数えた事実は事実）。
    expect(r.frames).toBe(20);
  });

  it("🔴 可変レートでは経過時間から計算する（平均 fps で割らない）", () => {
    // 前半 20ms・後半 60ms。平均は 40ms だが、測る区間は前半に偏っている。
    const vec = [0, ...Array.from({ length: 19 }, () => 20), ...Array.from({ length: 20 }, () => 60)];
    const cine: XaCineSource = { numberOfFrames: 40, frameTimeVectorMs: vec };
    const r = run(cine, 0, 10)!;
    expect(r.rateUniform).toBe(false);
    expect(r.warnings).toContain("variableFrameTime");
    // 経過は 20ms × 10 = 200ms → 6.0 frames@30fps
    expect(r.elapsedMs!).toBeCloseTo(200, 6);
    expect(r.tfc30!).toBeCloseTo(6, 6);
    // 平均 fps で割ると 10 × 30 / (1000/40) = 12.0 になる。**一致しないこと**を固定する。
    const byMeanFps = (10 * TIMI_REFERENCE_FPS) / r.fps;
    expect(Math.abs(byMeanFps - r.tfc30!)).toBeGreaterThan(1);
  });
});

describe("computeTimiFrameCount — CTFC", () => {
  it("🔴 CTFC は LAD のときだけ", () => {
    const lad = run(cineAt(30), 10, 40, "lad")!;
    expect(lad.ctfc!).toBeCloseTo(30 / 1.7, 6);
    expect(run(cineAt(30), 10, 40, "lcx")!.ctfc).toBeNull();
    expect(run(cineAt(30), 10, 40, "rca")!.ctfc).toBeNull();
  });

  it("🔴 換算できていなければ CTFC も出さない（生フレーム数を 1.7 で割らない）", () => {
    const r = run(cineNoTags(), 10, 40, "lad")!;
    expect(r.tfc30).toBeNull();
    expect(r.ctfc).toBeNull();
    expect(ctfcForVessel("lad", null)).toBeNull();
  });
});

describe("computeTimiFrameCount — 数字を出さない条件", () => {
  it("到達 ≤ 開始 なら換算値を出さず endBeforeStart を出す", () => {
    for (const [s, e] of [
      [40, 10],
      [10, 10],
    ]) {
      const r = run(cineAt(30), s, e)!;
      expect(r.tfc30, `${s}→${e}`).toBeNull();
      expect(r.warnings).toContain("endBeforeStart");
    }
  });

  it("開始が先頭／到達が末尾なら注記を出す", () => {
    expect(run(cineAt(30), 0, 40)!.warnings).toContain("startAtFirstFrame");
    expect(run(cineAt(30, 96), 10, 95)!.warnings).toContain("endAtLastFrame");
  });

  it("範囲外・非整数は null（黙って丸めない）", () => {
    expect(run(cineAt(30, 50), -1, 10)).toBeNull();
    expect(run(cineAt(30, 50), 10, 50)).toBeNull();
    expect(run(cineAt(30, 50), 1.5, 10)).toBeNull();
  });

  it("差分表示のまま測ったことを出自に残す", () => {
    const r = computeTimiFrameCount({
      vessel: "rca",
      startFrame: 10,
      endFrame: 40,
      cine: cineAt(30),
      subtracted: true,
    })!;
    expect(r.warnings).toContain("subtracted");
  });

  it("rateNot30 は 30±0.5fps の外でだけ付く", () => {
    expect(run(cineAt(30.3), 10, 40)!.warnings).not.toContain("rateNot30");
    expect(run(cineAt(31), 10, 40)!.warnings).toContain("rateNot30");
  });
});

describe("frameElapsedMs / isUniformFrameTime", () => {
  it("経過時間は範囲外・逆順で null", () => {
    const c = cineAt(30, 50);
    expect(frameElapsedMs(c, 10, 40)).toBeCloseTo((30 * 1000) / 30, 6);
    expect(frameElapsedMs(c, 40, 10)).toBeNull();
    expect(frameElapsedMs(c, 10, 50)).toBeNull();
  });

  it("等間隔は true、可変は false", () => {
    expect(isUniformFrameTime(cineAt(30))).toBe(true);
    expect(isUniformFrameTime({ numberOfFrames: 4, frameTimeVectorMs: [0, 20, 60, 20] })).toBe(false);
  });
});

describe("meanInRect", () => {
  const W = 4;
  const H = 3;
  // 0..11 を並べた 4×3。
  const values = Float32Array.from(Array.from({ length: W * H }, (_, i) => i));

  it("矩形の中だけを平均する", () => {
    // (1,0)-(2,1) → 1,2,5,6 → 3.5
    expect(meanInRect(values, W, H, { x0: 1, y0: 0, x1: 2, y1: 1 })!).toBeCloseTo(3.5, 6);
  });

  it("矩形が画像からはみ出しても外を数えない", () => {
    expect(meanInRect(values, W, H, { x0: -5, y0: -5, x1: 0, y1: 0 })!).toBeCloseTo(0, 6);
  });

  it("座標の順序が逆でも同じ", () => {
    const a = meanInRect(values, W, H, { x0: 1, y0: 0, x1: 2, y1: 1 })!;
    const b = meanInRect(values, W, H, { x0: 2, y0: 1, x1: 1, y1: 0 })!;
    expect(a).toBeCloseTo(b, 9);
  });
});

describe("arrivalCandidate", () => {
  it("ベースラインから立ち上がった最初の添字を返す", () => {
    // 先頭 5 フレームが 100 前後、その後 60 へ落ちる（造影で暗くなる）。
    const curve = [100, 101, 99, 100, 100, 100, 60, 55, 50];
    expect(arrivalCandidate(curve, { baselineFrames: 5 })).toBe(6);
  });

  it("🔴 ベースライン区間より前は返さない（自分の材料を到達と呼ばない）", () => {
    // ベースラインの中に谷があっても、その添字は返さない。
    const curve = [100, 100, 40, 100, 100, 100, 100, 100, 30];
    const i = arrivalCandidate(curve, { baselineFrames: 5 });
    expect(i == null || i >= 5).toBe(true);
  });

  it("ベースラインが汚れていると null を返す（間違った答えより出さない方を選ぶ）", () => {
    // 🔑 これは弱点ではなく設計。ベースラインに外れ値が混ざると σ が膨らみ、
    //    立ち上がりが埋もれる。**候補を出さない**ので、人が自分で選ぶことになる。
    //    黙って別のフレームを返すより良い（候補は「補助」であって決定ではない）。
    const curve = [10, 100, 100, 100, 100, 100, 60];
    expect(arrivalCandidate(curve, { baselineFrames: 5 })).toBeNull();
  });

  it("立ち上がりが無ければ null（無理に返さない）", () => {
    expect(arrivalCandidate([100, 100, 100, 100, 100, 100, 100], { baselineFrames: 5 })).toBeNull();
  });

  it("平坦すぎるベースラインで 1 の揺れを到達と呼ばない", () => {
    // sd = 0 の合成画像。床が無いと i=5 を返してしまう。
    const curve = [1000, 1000, 1000, 1000, 1000, 999.9, 400];
    expect(arrivalCandidate(curve, { baselineFrames: 5 })).toBe(6);
  });

  it("材料が足りなければ null", () => {
    expect(arrivalCandidate([100], { baselineFrames: 5 })).toBeNull();
    expect(arrivalCandidate([], { baselineFrames: 5 })).toBeNull();
  });

  it("差分（明るくなる）でも同じ形で使える", () => {
    const curve = [10, 10, 10, 10, 10, 10, 80];
    expect(arrivalCandidate(curve, { baselineFrames: 5, direction: "brighter" })).toBe(6);
  });
});
