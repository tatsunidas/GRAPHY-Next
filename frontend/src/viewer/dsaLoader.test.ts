import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `dsaLoader` は Cornerstone に触るので、**触る口だけ**を差し替えて純ロジックを検査する。
 * 見たいのは同位相マスク（フレームごとの計画）まわりの合成規則で、描画そのものではない。
 */
vi.mock("@cornerstonejs/core", () => ({
  metaData: { get: () => undefined, addProvider: () => undefined },
  registerImageLoader: () => undefined,
  utilities: { VoxelManager: { createImageVoxelManager: () => ({ getScalarData: () => new Float32Array(0) }) } },
}));
vi.mock("./xaCine", () => ({ xaDataSetOf: () => null }));

const W = 64;
const H = 64;

/**
 * フレーム t の画素。
 *
 * <p>向きの違う構造を重ねた背景を **x へ `t * 0.5` px ずらして**描く（＝フレーム間に既知の
 * 平行移動がある）。造影は t>=6 で入る。
 *
 * <p>🔴 **造影を「一様なオフセット」にしてある。** 本物の造影は局所的だが、ここで見たいのは
 * 合成規則であって生理ではない。一様にしておくと `contrastDropSignal` は反応するのに
 * ZNCC は不変なので、**到達検出とエッジ合わせを 1 つのファントムで同時に検査できる**。
 *
 * <p>🔴 **造影が t>=6 なのには理由がある。** `pickMaskFrames` の基線は先頭 min(5, n-1)
 * フレームなので、5 フレーム以内に到達する造影は**原理的に検出できない**
 * （`fw/angio-design.md` §6.3 の「既知の限界」。`dsa.test.ts` にも固定してある）。
 * ここで 4 にすると、その既知の限界を「同位相マスクの退行」と読み違える検査になる。
 */
/** 一時的に「一方向の縞だけ」の画像へ差し替えるための口（アパーチャ問題の検査用）。 */
let stripeMode: ((x: number, y: number) => number) | null = null;

const pixelsOf = (id: string): Float32Array => {
  const t = Number(id.replace("f", ""));
  const out = new Float32Array(W * H);
  const shift = t * 0.5;
  if (stripeMode) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = stripeMode(x - shift, y);
    return out;
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x - shift;
      const v = y;
      const stripe = 40 * Math.sin(((0.6 * u + 0.8 * v) * 2 * Math.PI) / 9);
      const spine = 120 * Math.exp(-(((u - 26) / 4) ** 2));
      const ribs = 55 * Math.sin((v * 2 * Math.PI) / 13);
      let blobs = 0;
      for (const [bx, by] of [[18, 20], [44, 34], [30, 48]]) {
        blobs += 110 * Math.exp(-(((u - bx) ** 2 + (v - by) ** 2) / 24));
      }
      out[y * W + x] = 1000 + stripe + spine + ribs + blobs - (t >= 6 ? 400 : 0);
    }
  }
  return out;
};

vi.mock("./pixelCalibration", () => ({
  readModalitySlice: async (id: string) => ({ values: pixelsOf(id), width: W, height: H, unit: "raw" }),
}));

const frameIds = Array.from({ length: 10 }, (_, i) => `f${i}`);

let mod: typeof import("./dsaLoader");

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./dsaLoader");
});

async function session(): Promise<string> {
  const token = await mod.prepareDsaSession({ frameIds: [...frameIds] });
  expect(token).not.toBeNull();
  return token!;
}

/** 計画: ライブ t にマスク (t % 3) を当て、シフトは (t, -t)。 */
function plan(n = frameIds.length): (import("./dsaLoader").DsaFramePlanEntry | null)[] {
  return Array.from({ length: n }, (_, t) => ({
    maskImageIds: [frameIds[t % 3]],
    maskFrames: [t % 3],
    dx: t,
    dy: -t,
  }));
}

describe("同位相マスク — 計画の受け入れ", () => {
  it("フレーム数が合わない計画は受け取らない（黙ってずれた絵を出さない）", async () => {
    const token = await session();
    expect(mod.setDsaFramePlan(token, plan(3), "x")).toBe(false);
    expect(mod.dsaSessionState(token)?.framePlan).toBe(false);
  });

  it("計画を入れると framePlan が立ち、出自と枚数が出る", async () => {
    const token = await session();
    const p = plan();
    p[5] = null; // 当てられなかったフレーム
    expect(mod.setDsaFramePlan(token, p, "ラン 2")).toBe(true);
    const st = mod.dsaSessionState(token)!;
    expect(st.framePlan).toBe(true);
    expect(st.framePlanLabel).toBe("ラン 2");
    expect(st.framePlanCovered).toBe(frameIds.length - 1);
  });

  it("null を渡すと外れる", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "x");
    mod.setDsaFramePlan(token, null, null);
    expect(mod.dsaSessionState(token)?.framePlan).toBe(false);
  });
});

describe("同位相マスク — フレームごとの状態", () => {
  it("★ 状態はフレームを指定して初めて正しい（マスクもシフトもフレームで違う）", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "自ラン");
    expect(mod.dsaSessionState(token, 4)?.maskFrames).toEqual([1]);
    expect(mod.dsaSessionState(token, 5)?.maskFrames).toEqual([2]);
    expect(mod.dsaSessionState(token, 4)?.dx).toBe(4);
    expect(mod.dsaSessionState(token, 5)?.dx).toBe(5);
  });

  it("計画の無いフレームは既定のマスクに落ちる", async () => {
    const token = await session();
    const before = mod.dsaSessionState(token)!.maskFrames;
    const p = plan();
    p[7] = null;
    mod.setDsaFramePlan(token, p, "x");
    expect(mod.dsaSessionState(token, 7)?.maskFrames).toEqual(before);
    expect(mod.dsaSessionState(token, 7)?.dx).toBe(0);
  });
});

describe("シフトの合成 — 計画 ＋ 全体 ＋ 手動", () => {
  it("★ 3 つの足し算になる", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "x");
    mod.setDsaShift(token, 10, 20); // 全体
    mod.nudgeDsaShift(token, 0.5, -0.5, "current", 6); // 手動（そのフレームだけ）
    expect(mod.dsaSessionState(token, 6)?.dx).toBeCloseTo(6 + 10 + 0.5, 9);
    expect(mod.dsaSessionState(token, 6)?.dy).toBeCloseTo(-6 + 20 - 0.5, 9);
    // 隣のフレームには手動ぶんが乗らない。
    expect(mod.dsaSessionState(token, 7)?.dx).toBeCloseTo(7 + 10, 9);
  });

  it("scope=\"from\" はそのフレーム以降すべてに乗る", async () => {
    const token = await session();
    mod.nudgeDsaShift(token, 1, 0, "from", 4);
    expect(mod.dsaSessionState(token, 3)?.dx).toBe(0);
    for (let t = 4; t < frameIds.length; t++) expect(mod.dsaSessionState(token, t)?.dx).toBe(1);
  });

  it("scope=\"all\" は全体シフトを動かす（フレームごとの手動とは別腹）", async () => {
    const token = await session();
    mod.nudgeDsaShift(token, 2, 3, "all", 0);
    mod.nudgeDsaShift(token, 1, 1, "current", 5);
    expect(mod.dsaSessionState(token, 0)?.dx).toBe(2);
    expect(mod.dsaSessionState(token, 5)?.dx).toBe(3);
    mod.clearDsaNudge(token);
    expect(mod.dsaSessionState(token, 5)?.dx).toBe(2); // 全体ぶんは残る
  });

  it("🔴 手動ぶんは計画を入れ直しても消えない（別に持っているから）", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "a");
    mod.nudgeDsaShift(token, 0.25, 0, "current", 2);
    const p2 = plan();
    p2.forEach((e) => { if (e) e.dx += 100; });
    mod.setDsaFramePlan(token, p2, "b");
    expect(mod.dsaSessionState(token, 2)?.dx).toBeCloseTo(102.25, 9);
  });
});

describe("回転 — 既定は 0 で、足したときだけ効く", () => {
  it("既定は 0（既存の数値を動かさない）", async () => {
    const token = await session();
    expect(mod.dsaSessionState(token, 3)?.rotationDeg).toBe(0);
  });

  it("計画・全体・手動の回転が足し算になる", async () => {
    const token = await session();
    const p = plan();
    p.forEach((e) => { if (e) e.rotationDeg = 1; });
    mod.setDsaFramePlan(token, p, "x");
    mod.nudgeDsaRotation(token, 0.5, "all", 0);
    mod.nudgeDsaRotation(token, 0.25, "current", 4);
    expect(mod.dsaSessionState(token, 4)?.rotationDeg).toBeCloseTo(1.75, 9);
    expect(mod.dsaSessionState(token, 5)?.rotationDeg).toBeCloseTo(1.5, 9);
  });
});

describe("エッジ像での剛体合わせ", () => {
  it("★ 既知の平行移動を取り戻す（マスク f0 ／ ライブ f8 ＝ 4px ずれ）", async () => {
    const token = await session();
    const p: ReturnType<typeof plan> = frameIds.map(() => null);
    p[8] = { maskImageIds: [frameIds[0]], maskFrames: [0], dx: 0, dy: 0 };
    mod.setDsaFramePlan(token, p, "test");
    const r = await mod.alignDsaOnEdges(token, 8, "current");
    expect(r?.reliable).toBe(true);
    expect(r!.dx).toBeCloseTo(4, 1);
    expect(Math.abs(r!.dy)).toBeLessThan(0.2);
    expect(r!.rotationDeg).toBe(0);
  });

  it("🔴 ★ 計画が入っているフレームでも二重にずれない（足すのは「差」だから）", async () => {
    const token = await session();
    const p: ReturnType<typeof plan> = frameIds.map(() => null);
    // わざと 3px ずれた計画を入れておく。合わせたあとの**合計**が推定値に一致すること。
    p[8] = { maskImageIds: [frameIds[0]], maskFrames: [0], dx: 3, dy: -1, rotationDeg: 0 };
    mod.setDsaFramePlan(token, p, "test");
    mod.setDsaShift(token, 2, 2); // 全体シフトも入れておく
    const r = await mod.alignDsaOnEdges(token, 8, "current");
    expect(r?.reliable).toBe(true);
    const st = mod.dsaSessionState(token, 8)!;
    expect(st.dx).toBeCloseTo(r!.dx, 6);
    expect(st.dy).toBeCloseTo(r!.dy, 6);
  });

  it("scope=\"from\" は測った差を以降へ流す（1 枚で合わせて範囲に効かせる作法）", async () => {
    const token = await session();
    const before = mod.dsaSessionState(token, 9)!.dx;
    const r = await mod.alignDsaOnEdges(token, 5, "from");
    expect(r?.reliable).toBe(true);
    const delta = mod.dsaSessionState(token, 5)!.dx;
    expect(mod.dsaSessionState(token, 9)!.dx).toBeCloseTo(before + delta, 6);
    expect(mod.dsaSessionState(token, 4)!.dx).toBe(0); // 手前には効かない
  });

  it("🚨 合わせられなかったら足し込まない（合ったふりをしない）", async () => {
    const token = await session();
    // 一方向の縞しか無い画像に差し替える＝アパーチャ問題。
    const stripesOnly = (x: number, y: number) => 1000 + 40 * Math.sin(((0.6 * x + 0.8 * y) * 2 * Math.PI) / 9);
    stripeMode = stripesOnly;
    try {
      const r = await mod.alignDsaOnEdges(token, 8, "current");
      expect(r?.reliable).toBe(false);
      expect(mod.dsaSessionState(token, 8)?.dx).toBe(0);
    } finally {
      stripeMode = null;
    }
  });
});

describe("ラン全体のマスク指定は計画より強い", () => {
  it("🔴 「現在フレームをマスクに」を押したら計画は外れる（指定したのに変わらない絵を残さない）", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "x");
    expect(mod.dsaSessionState(token)?.framePlan).toBe(true);
    expect(mod.setDsaMaskFrames(token, [2])).toBe(true);
    const st = mod.dsaSessionState(token)!;
    expect(st.framePlan).toBe(false);
    expect(st.maskFrames).toEqual([2]);
  });
});

describe("既定の挙動を変えていないこと", () => {
  it("計画が無ければ状態は従来どおり（フレームを指定してもしなくても同じ）", async () => {
    const token = await session();
    mod.setDsaShift(token, 1.5, -2.5);
    const a = mod.dsaSessionState(token)!;
    const b = mod.dsaSessionState(token, 3)!;
    expect(a.dx).toBe(1.5);
    expect(b.dx).toBe(1.5);
    expect(a.maskFrames).toEqual(b.maskFrames);
    expect(a.framePlan).toBe(false);
  });

  it("マスクの自動選択は造影到達より前を選ぶ（既存の規則を壊していない）", async () => {
    const token = await session();
    const st = mod.dsaSessionState(token)!;
    expect(st.maskFrames.length).toBeGreaterThan(0);
    for (const i of st.maskFrames) expect(i).toBeLessThan(6);
  });
});


describe("自動位置合わせのトグルとレベル合わせ（§6.9 5-F/5-G）", () => {
  it("🔴 計画が入るとレベル合わせが効き、外すと戻る（既定経路は触らない）", async () => {
    const token = await session();
    expect(mod.dsaSessionState(token)?.levelMatch).toBe(false);
    mod.setDsaFramePlan(token, plan(), "自動");
    expect(mod.dsaSessionState(token)?.levelMatch).toBe(true);
    mod.setDsaFramePlan(token, null, null);
    expect(mod.dsaSessionState(token)?.levelMatch).toBe(false);
  });

  it("🚨 ラン全体のマスクを人が指定したらレベル合わせも降りる（計画ごと外れるので）", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "自動");
    mod.setDsaMaskFrames(token, [1, 2]);
    const st = mod.dsaSessionState(token)!;
    expect(st.framePlan).toBe(false);
    expect(st.levelMatch).toBe(false);
  });

  it("★ 残差は計画の dx/dy とは別枠で、トグルで即座に出入りする", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "自動");
    const before = mod.dsaSessionState(token, 4)!;
    expect(before.autoAlignAvailable).toBe(false);

    const align = Array.from({ length: frameIds.length }, () => ({ dx: 0.25, dy: -0.5 }));
    expect(mod.setDsaFrameAlignments(token, align)).toBe(true);

    const on = mod.dsaSessionState(token, 4)!;
    expect(on.autoAlignAvailable).toBe(true);
    expect(on.autoAlign).toBe(true);
    expect(on.dx).toBeCloseTo(before.dx + 0.25, 10);
    expect(on.dy).toBeCloseTo(before.dy - 0.5, 10);

    mod.setDsaAutoAlign(token, false);
    const off = mod.dsaSessionState(token, 4)!;
    // 🔑 計画そのものは無傷。**足すかどうかだけ**が変わる（再計算が要らない）。
    expect(off.dx).toBeCloseTo(before.dx, 10);
    expect(off.dy).toBeCloseTo(before.dy, 10);
    expect(off.autoAlignAvailable).toBe(true);
  });

  it("計画が無ければ残差は受け取らない（計画なしに足しても意味がない）", async () => {
    const token = await session();
    expect(mod.setDsaFrameAlignments(token, [{ dx: 1, dy: 1 }])).toBe(false);
  });

  it("長さの合わない残差は受け取らない", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "自動");
    expect(mod.setDsaFrameAlignments(token, [{ dx: 1, dy: 1 }])).toBe(false);
  });
});


describe("背景で合わせる（autoAlignDsa）— 適用範囲が効く（§6.13）", () => {
  it("🔴 ★ 「このフレーム」ならそのフレームだけ動く（従来はラン全体に書いていた）", async () => {
    const token = await session();
    const before = mod.dsaSessionState(token, 2)!;
    await mod.autoAlignDsa(token, 7, "current");
    const other = mod.dsaSessionState(token, 2)!;
    const here = mod.dsaSessionState(token, 7)!;
    expect(other.dx).toBeCloseTo(before.dx, 10);
    expect(other.dy).toBeCloseTo(before.dy, 10);
    expect(Math.hypot(here.dx - before.dx, here.dy - before.dy)).toBeGreaterThan(0);
  });

  it("「以降」なら手前は動かない", async () => {
    const token = await session();
    const before = mod.dsaSessionState(token, 2)!;
    await mod.autoAlignDsa(token, 6, "from");
    expect(mod.dsaSessionState(token, 2)!.dx).toBeCloseTo(before.dx, 10);
    expect(mod.dsaSessionState(token, 8)!.dx).not.toBeCloseTo(before.dx, 10);
  });

  it("「全部」は全フレームに効く（既定）", async () => {
    const token = await session();
    const before = mod.dsaSessionState(token, 2)!;
    await mod.autoAlignDsa(token, 7);
    const a = mod.dsaSessionState(token, 2)!;
    const b = mod.dsaSessionState(token, 9)!;
    expect(a.dx).toBeCloseTo(b.dx, 10);
    expect(a.dx).not.toBeCloseTo(before.dx, 10);
  });

  it("🚨 二重に掛からない（2 回押しても同じ位置に収束する）", async () => {
    const token = await session();
    const first = await mod.autoAlignDsa(token, 7);
    const afterFirst = mod.dsaSessionState(token, 7)!;
    await mod.autoAlignDsa(token, 7);
    const afterSecond = mod.dsaSessionState(token, 7)!;
    expect(first).not.toBeNull();
    expect(afterSecond.dx).toBeCloseTo(afterFirst.dx, 6);
    expect(afterSecond.dy).toBeCloseTo(afterFirst.dy, 6);
  });

  it("「ずらしを戻す」で消える（計画は残る）", async () => {
    const token = await session();
    mod.setDsaFramePlan(token, plan(), "自動");
    const planned = mod.dsaSessionState(token, 7)!;
    await mod.autoAlignDsa(token, 7, "current");
    mod.clearDsaNudge(token);
    mod.setDsaShift(token, 0, 0);
    const back = mod.dsaSessionState(token, 7)!;
    expect(back.dx).toBeCloseTo(planned.dx, 10);
    expect(back.framePlan).toBe(true);
  });
});


describe("measureDsaResidualAll — 全フレームの「合っていなさ」（§6.14）", () => {
  it("🔴 ★ 自己差分のフレームは残差 0（マスクが自分自身なら差は厳密にゼロ）", async () => {
    const token = await session();
    // 全フレームが自分自身を引く計画。
    const selfPlan = frameIds.map((id, t) => ({ maskImageIds: [id], maskFrames: [t], dx: 0, dy: 0 }));
    expect(mod.setDsaFramePlan(token, selfPlan, "self")).toBe(true);
    const r = await mod.measureDsaResidualAll(token);
    expect(r).not.toBeNull();
    for (const v of r!) expect(v).toBe(0);
  });

  it("★ 長さは必ずフレーム数と一致する", async () => {
    const token = await session();
    const r = await mod.measureDsaResidualAll(token);
    expect(r).toHaveLength(frameIds.length);
  });

  it("★ マスクをずらすと残差が増える（合っていないことを拾えている）", async () => {
    const token = await session();
    const selfPlan = frameIds.map((id, t) => ({ maskImageIds: [id], maskFrames: [t], dx: 0, dy: 0 }));
    mod.setDsaFramePlan(token, selfPlan, "self");
    const before = (await mod.measureDsaResidualAll(token))!;
    mod.setDsaShift(token, 3, 0);
    const after = (await mod.measureDsaResidualAll(token))!;
    expect(before[5]).toBe(0);
    expect(after[5]).toBeGreaterThan(0);
  });

  it("進捗を知らせ、中止できる", async () => {
    const token = await session();
    const seen: number[] = [];
    await mod.measureDsaResidualAll(token, (done) => seen.push(done));
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(frameIds.length);

    let calls = 0;
    const stopped = await mod.measureDsaResidualAll(token, undefined, () => ++calls > 2);
    expect(stopped).toBeNull();
  });

  it("セッションが無ければ null", async () => {
    expect(await mod.measureDsaResidualAll("nope")).toBeNull();
  });
});
