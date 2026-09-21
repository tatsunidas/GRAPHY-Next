import { describe, expect, it } from "vitest";
import { buildPhaseMaskPlan, PHASE_DISAGREEMENT_LIMIT, type RunTrack } from "./xaPhaseMask";

/**
 * 解析的な運動（位置 = 振幅、速度 = 向き）だけで作った 1 ラン。
 * 画素は要らない——このモジュールは画像に触らないのが設計（類似度は `score` で外から）。
 */
function run(positions: number[], axis: [number, number] = [1, 0], reliable?: boolean[]): RunTrack {
  const n = positions.length;
  const sdot = positions.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    return (positions[b] - positions[a]) / 2;
  });
  return {
    s: Float64Array.from(positions),
    sdot: Float64Array.from(sdot),
    dx: positions.map((p) => p * axis[0]),
    dy: positions.map((p) => p * axis[1]),
    reliable: reliable ?? positions.map(() => true),
    phase: null,
  };
}

/** 三角波（一定速度で往復する）。位置が同じでも向きが逆になる点が必ず出る。 */
function triangle(n: number, period: number, amp: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const u = (i % period) / period;
    return u < 0.5 ? amp * (4 * u - 1) : amp * (3 - 4 * u);
  });
}

describe("buildPhaseMaskPlan — 残差シフトは追尾からただで出る", () => {
  it("★ シフトは「ライブの位置 − マスクの位置」", () => {
    const pos = triangle(24, 8, 5);
    const r = run(pos, [0.6, 0.8]);
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3, 4, 5, 6, 7] });
    for (const e of plan.entries) {
      if (e.maskFrame == null) continue;
      expect(e.dx).toBeCloseTo(r.dx[e.liveFrame] - r.dx[e.maskFrame], 12);
      expect(e.dy).toBeCloseTo(r.dy[e.liveFrame] - r.dy[e.maskFrame], 12);
    }
  });

  it("2 ラン間の定数ずれ（runOffset）がシフトに乗る", () => {
    const r = run(triangle(16, 8, 5));
    const plan = buildPhaseMaskPlan(r, r, {
      usableMaskFrames: [0, 1, 2, 3, 4, 5, 6, 7],
      runOffset: { dx: 2.5, dy: -1.25 },
    });
    const e = plan.entries.find((x) => x.maskFrame != null)!;
    expect(e.dx).toBeCloseTo(r.dx[e.liveFrame] - r.dx[e.maskFrame!] + 2.5, 12);
    expect(e.dy).toBeCloseTo(r.dy[e.liveFrame] - r.dy[e.maskFrame!] - 1.25, 12);
  });

  it("選んだマスクは位置と向きが合っている（同じ振幅の逆向きを掴まない）", () => {
    const pos = triangle(24, 8, 5);
    const r = run(pos);
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3, 4, 5, 6, 7] });
    let checked = 0;
    for (const e of plan.entries) {
      if (e.status !== "ok" || e.maskFrame == null) continue;
      if (Math.abs(r.sdot[e.liveFrame]) < 0.5) continue; // 折り返し点は符号がノイズ
      expect(Math.sign(r.sdot[e.maskFrame])).toBe(Math.sign(r.sdot[e.liveFrame]));
      expect(Math.abs(r.s[e.maskFrame] - r.s[e.liveFrame])).toBeLessThan(1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
  });
});

describe("buildPhaseMaskPlan — 使ってよいマスクだけで照合する", () => {
  it("🔴 ★ 絞ってから照合する（照合してから捨てない）", () => {
    // ライブ 8 の位置は 3.0。いちばん近いのは**使えない**フレーム 12（3.0）だが、
    // 使えるのは 0〜7 だけ。「照合してから捨てる」実装だと候補が全部消えて null になる。
    const pos = [0, 1, 2, 3, 4, 3, 2, 1, 3, 4, 5, 4, 3, 2, 1, 0];
    const r = run(pos);
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3, 4, 5, 6, 7], k: 3 });
    const e = plan.entries[8];
    expect(e.maskFrame).not.toBeNull();
    expect(e.maskFrame!).toBeLessThanOrEqual(7);
    expect(e.amplitudeDiff).toBeCloseTo(0, 9);
  });

  it("🔴 マスクの振幅範囲がライブを覆っていなければ maskFrame は null（無理に当てない）", () => {
    // 使えるマスクは 0〜3（位置 0〜3）だけ。ライブの 8〜10 は位置 5 まで行く。
    const pos = [0, 1, 2, 3, 2, 1, 0, 2, 5, 6, 5, 2];
    const r = run(pos);
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3] });
    expect(plan.entries[9].maskFrame).toBeNull();
    expect(plan.entries[9].status).toBe("outOfRange");
    expect(plan.summary.outOfRange).toBeGreaterThan(0);
  });

  it("追尾できていないライブフレームは unreliable で当てない", () => {
    const pos = triangle(12, 6, 4);
    const reliable = pos.map((_, i) => i !== 5);
    const r = run(pos, [1, 0], reliable);
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3, 4, 5] });
    expect(plan.entries[5].status).toBe("unreliable");
    expect(plan.entries[5].maskFrame).toBeNull();
    expect(plan.summary.unreliable).toBe(1);
  });

  it("追尾できていないマスクフレームは候補にしない", () => {
    const pos = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3];
    const reliable = pos.map((_, i) => i !== 3);
    const r = run(pos, [1, 0], reliable);
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3, 4, 5] });
    for (const e of plan.entries) expect(e.maskFrame).not.toBe(3);
  });
});

describe("buildPhaseMaskPlan — 画像類似度で 1 個に決める", () => {
  it("★ 振幅で同点の候補は score が決める（振幅の順位のままにしない）", () => {
    // 位置 2 のフレームが 2 つ（1 と 5）。振幅差はどちらも 0 で同点。
    const pos = [0, 2, 4, 2, 0, 2, 4, 2];
    const r = run(pos);
    const withoutScore = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3, 4, 5, 6, 7], k: 3 });
    // 同点なら若い番号（決定性★）。
    expect(withoutScore.entries[1].maskFrame).toBe(1);

    const withScore = buildPhaseMaskPlan(r, r, {
      usableMaskFrames: [0, 1, 2, 3, 4, 5, 6, 7],
      k: 3,
      score: (_live, maskFrame) => (maskFrame === 5 ? 0.99 : 0.1),
    });
    expect(withScore.entries[1].maskFrame).toBe(5);
    expect(withScore.entries[1].similarity).toBeCloseTo(0.99, 9);
  });

  it("score には「その候補を選んだときのシフト」が渡る", () => {
    const pos = [0, 2, 4, 2, 0];
    const r = run(pos, [1, 0]);
    const seen: Array<[number, number, number]> = [];
    buildPhaseMaskPlan(r, r, {
      usableMaskFrames: [0, 1, 2, 3, 4],
      k: 5,
      score: (live, maskFrame, dx) => {
        seen.push([live, maskFrame, dx]);
        return -Math.abs(dx);
      },
    });
    for (const [live, maskFrame, dx] of seen) expect(dx).toBeCloseTo(r.dx[live] - r.dx[maskFrame], 12);
  });
});

describe("buildPhaseMaskPlan — 位相は交差確認にだけ使う", () => {
  it("位相が無ければ phaseMaskFrame は null（位相で決めにいかない）", () => {
    const r = run(triangle(12, 6, 4));
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3, 4, 5] });
    for (const e of plan.entries) expect(e.phaseMaskFrame).toBeNull();
    expect(plan.summary.phaseDisagreements).toBe(0);
  });

  it("★ 位相の選択と振幅の選択が食い違ったら数える（どちらが正しいかは決めない）", () => {
    // 🔴 これが起きるのは「同じ位置に居るのに、心周期の中の時間割合が違う」とき。
    //    収縮期の長さが変わらないまま RR だけ延びると実際にこうなる（§6.7.1）。
    //    マスク run とライブ run は**同じ位置**を通るが、位相の刻み方が違う。
    const pos = [0, 2, 4, 2, 0, 2, 4, 2];
    const maskRun = run(pos);
    const liveRun = run(pos);
    maskRun.phase = Float64Array.from(pos.map((_, i) => (i % 4) / 4));        // 0 / .25 / .5 / .75
    liveRun.phase = Float64Array.from(pos.map((_, i) => [0, 0.4, 0.6, 0.8][i % 4]));

    const plan = buildPhaseMaskPlan(maskRun, liveRun, {
      usableMaskFrames: [0, 1, 2, 3, 4, 5, 6, 7],
      k: 1,
    });
    const disagreeing = plan.entries.filter(
      (e) => e.phaseDisagreement != null && e.phaseDisagreement > PHASE_DISAGREEMENT_LIMIT,
    );
    expect(disagreeing.length).toBeGreaterThan(0);
    expect(plan.summary.phaseDisagreements).toBe(disagreeing.length);
    // 食い違っても**振幅の選択を曲げない**（位相は参考）。
    for (const e of disagreeing) {
      expect(Math.abs(maskRun.s[e.maskFrame!] - liveRun.s[e.liveFrame])).toBeLessThan(1e-9);
    }
  });
});

describe("buildPhaseMaskPlan — 要約", () => {
  it("内訳の合計がフレーム数と一致する", () => {
    const pos = [0, 1, 2, 3, 2, 1, 0, 2, 5, 6, 5, 2];
    const r = run(pos, [1, 0], pos.map((_, i) => i !== 7));
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [0, 1, 2, 3] });
    const { ok, directionRelaxed, outOfRange, unreliable } = plan.summary;
    expect(ok + directionRelaxed + outOfRange + unreliable).toBe(pos.length);
  });

  it("使えるマスクが 1 枚も無ければ全部 outOfRange（黙って当てない）", () => {
    const r = run(triangle(10, 5, 3));
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: [] });
    expect(plan.summary.outOfRange).toBe(10);
    for (const e of plan.entries) expect(e.maskFrame).toBeNull();
  });
});


describe("buildPhaseMaskPlan — 範囲外のクランプ（§6.9 5-E）", () => {
  // マスクは 1 心拍ぶん（振幅 ±10）、ライブは造影後で少し大きく振れる（±12）。
  const cycle = (amp: number, n: number): number[] =>
    Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * i) / 17));
  const mask = run(cycle(10, 34));
  const live = run(cycle(12, 60));
  const usable = Array.from({ length: 34 }, (_, i) => i);

  it("🔴 既定では範囲外に穴が開く（今までどおり）", () => {
    const plan = buildPhaseMaskPlan(mask, live, { usableMaskFrames: usable });
    expect(plan.summary.outOfRange).toBeGreaterThan(0);
    expect(plan.summary.clamped).toBe(0);
    expect(plan.entries.some((e) => e.maskFrame == null)).toBe(true);
  });

  it("🔴 ★ clampOutOfRange で穴が無くなり、外挿したことが status に残る", () => {
    const plan = buildPhaseMaskPlan(mask, live, { usableMaskFrames: usable, clampOutOfRange: true });
    expect(plan.summary.outOfRange).toBe(0);
    expect(plan.summary.clamped).toBeGreaterThan(0);
    // 🔑 **穴が 1 つも無い**こと。ここが実機の「そのフレームだけ明るい」の直接の治療。
    for (const e of plan.entries) expect(e.maskFrame).not.toBeNull();
  });

  it("外挿した量は 2px 級にとどまる（端のマスクを当てているだけ）", () => {
    const plan = buildPhaseMaskPlan(mask, live, { usableMaskFrames: usable, clampOutOfRange: true });
    const worst = Math.max(...plan.entries.filter((e) => e.status === "clamped").map((e) => e.amplitudeDiff));
    expect(worst).toBeLessThan(3);
  });

  it("範囲内のフレームの答えはクランプで変わらない", () => {
    const a = buildPhaseMaskPlan(mask, live, { usableMaskFrames: usable });
    const b = buildPhaseMaskPlan(mask, live, { usableMaskFrames: usable, clampOutOfRange: true });
    for (let i = 0; i < a.entries.length; i++) {
      if (a.entries[i].status === "outOfRange") continue;
      expect(b.entries[i].maskFrame).toBe(a.entries[i].maskFrame);
      expect(b.entries[i].status).toBe(a.entries[i].status);
    }
  });

  it("追尾が外れたフレームはクランプでも埋めない（振幅そのものが無いので）", () => {
    const unreliable = [...Array(60)].map((_, i) => i !== 7);
    const shaky = run(cycle(12, 60), [1, 0], unreliable);
    const plan = buildPhaseMaskPlan(mask, shaky, { usableMaskFrames: usable, clampOutOfRange: true });
    expect(plan.entries[7].status).toBe("unreliable");
    expect(plan.entries[7].maskFrame).toBeNull();
  });
});


describe("selfMaskFrames — 自分自身は「決め打ち」ではなく「候補」（§6.11）", () => {
  const cycle = (amp: number, n: number): number[] =>
    Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * i) / 17));
  const r = run(cycle(10, 40));
  const usable = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const selfFrames = [0, 1, 2, 3, 4, 5, 6, 7];

  /** 画像類似度の代役: 同じフレームなら 1、違えば振幅の近さで 0〜0.9。 */
  const score = (liveFrame: number, maskFrame: number): number =>
    liveFrame === maskFrame ? 1 : 0.9 / (1 + Math.abs(r.s[liveFrame] - r.s[maskFrame]));

  it("🔴 ★ 候補に入れるだけで、score（ZNCC 相当）が自分自身を選ぶ", () => {
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: usable, selfMaskFrames: selfFrames, score });
    for (const t of selfFrames) {
      expect(plan.entries[t].maskFrame).toBe(t);
      expect(plan.entries[t].dx).toBe(0);
      expect(plan.entries[t].dy).toBe(0);
      expect(plan.entries[t].status).toBe("ok");
    }
  });

  it("🚨 候補に入れないと他人が選ばれる（これが 1〜8 で起きていたこと）", () => {
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: usable, score });
    const picked = selfFrames.map((t) => plan.entries[t].maskFrame);
    expect(picked.every((m) => m == null || !selfFrames.includes(m))).toBe(true);
  });

  it("造影が入っているフレーム（候補外）は自分自身を選ばない", () => {
    const plan = buildPhaseMaskPlan(r, r, { usableMaskFrames: usable, selfMaskFrames: selfFrames, score });
    for (let t = 21; t < 40; t++) expect(plan.entries[t].maskFrame).not.toBe(t);
  });

  it("★ 追尾が外れていても自分自身は当てられる（ずらす必要が無いので）", () => {
    const unreliable = Array.from({ length: 40 }, (_, i) => i !== 3);
    const shaky = run(cycle(10, 40), [1, 0], unreliable);
    const plan = buildPhaseMaskPlan(r, shaky, { usableMaskFrames: usable, selfMaskFrames: selfFrames, score });
    expect(plan.entries[3].maskFrame).toBe(3);
    expect(plan.entries[3].status).toBe("ok");
  });

  it("🚨 2 ラン間では「同じ番号」は自分自身ではない（selfMaskFrames を渡さない）", () => {
    const other = run(cycle(10, 40).map((v) => v + 1));
    const plan = buildPhaseMaskPlan(other, r, { usableMaskFrames: usable, runOffset: { dx: 2.5, dy: -1 } });
    const e = plan.entries.find((x) => x.maskFrame != null)!;
    // 自己短絡が効いていたら dx は 0 になってしまう。runOffset が乗っていることを確かめる。
    expect(e.dx).toBeCloseTo(r.dx[e.liveFrame] - other.dx[e.maskFrame!] + 2.5, 10);
  });
});
