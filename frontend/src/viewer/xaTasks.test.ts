/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 段（ステップ）モデルの検査（`fw/angio-design.md` §21.6）。
 *
 * <p>ここで守るのは**繋がりの健全性**（巡回が無い・全段が到達可能・上流を消さない）と、
 * **状態の導出規則**。UI を起動せずに検査できるようにするために純ロジックへ切り出してある。
 */
import { describe, expect, it } from "vitest";
import {
  QLV_STEPS,
  TIMI_STEPS,
  deriveTimiSteps,
  clearedBy,
  deriveQlvSteps,
  invalidatedBy,
  type QlvTaskState,
} from "./xaTasks";
import type { TimiTaskState } from "./xaTasks";

// ─────────────────────────────────────────────────────────────────────────
// QLV（左室造影）— `fw/angio-design.md` §9.2 / A5b
// ─────────────────────────────────────────────────────────────────────────

/** 段の繋がりの健全性は**タスクによらず**同じ規則で守る。 */
describe.each([
  ["QLV", QLV_STEPS],
  ["TIMI", TIMI_STEPS],
])("段の繋がり（%s）", (_name, STEPS) => {
  const order = STEPS.map((s) => s.id);

  it("id が重複していない", () => {
    expect(new Set(order).size).toBe(order.length);
  });

  it("invalidates の宛先がすべて実在し、必ず後ろの段を指す", () => {
    for (const s of STEPS) {
      for (const id of s.invalidates) {
        expect(order).toContain(id);
        expect(order.indexOf(id)).toBeGreaterThan(order.indexOf(s.id));
      }
    }
  });

  it("巡回していない", () => {
    for (const s of STEPS) expect(invalidatedBy(s.id, STEPS)).not.toContain(s.id);
  });

  it("手修正の持ち主が重複していない", () => {
    const owners = STEPS.flatMap((s) => s.owns);
    expect(new Set(owners).size).toBe(owners.length);
  });

  it("🚨 どの段も上流が持つ手修正を捨てない", () => {
    for (const s of STEPS) {
      for (const key of s.clears) {
        const owner = STEPS.find((x) => x.owns.includes(key));
        expect(owner, `${key} の持ち主が居ない`).toBeDefined();
        expect(order.indexOf(owner!.id)).toBeGreaterThanOrEqual(order.indexOf(s.id));
      }
    }
  });

  it("最後の段は何も無効にしない", () => {
    expect(STEPS[STEPS.length - 1].invalidates).toEqual([]);
  });
});

describe("deriveQlvSteps", () => {
  function qlv(over: Partial<QlvTaskState> = {}): QlvTaskState {
    return {
      hasFrames: true,
      framesManual: false,
      frameWarnings: [],
      calibrated: true,
      calibrationSource: "user-catheter",
      edPoints: 8,
      esPoints: 8,
      minPoints: 4,
      hasResult: true,
      canSave: true,
      saved: false,
      ...over,
    };
  }
  const byId = (s: QlvTaskState) => new Map(deriveQlvSteps(s).map((x) => [x.id, x]));

  it("段は QCA と別（ED/ES があり、中心線・エッジが無い）", () => {
    const ids = deriveQlvSteps(qlv()).map((x) => x.id);
    expect(ids).toEqual(["frames", "calibration", "edContour", "esContour", "result", "save"]);
    expect(ids).not.toContain("centerline");
  });

  it("🚨 未校正の理由が QCA と違う（EF は出せる、と伝える）", () => {
    // QCA では未校正＝数値が px になる。QLV では EF はスケール不変なので正しい。
    // 同じ skipped でも「飛ばすと何が失われるか」が違うので、文言を分ける。
    const c = byId(qlv({ calibrated: false })).get("calibration")!;
    expect(c.state).toBe("skipped");
    expect(c.reasonKey).toBe("qlv.step.reason.uncalibrated");
    expect(c.reasonKey).not.toBe("xa.step.reason.uncalibrated");
  });

  it("★提案に警告が付いている間は done にしない（黙って承認済みにしない）", () => {
    const f = byId(qlv({ frameWarnings: ["fillingNotDetected"] })).get("frames")!;
    expect(f.state).toBe("invalid");
    expect(f.reasonKey).toBe("qlv.step.reason.fillingNotDetected");
  });

  it("警告があっても人が選び直せば done になる", () => {
    const f = byId(qlv({ frameWarnings: ["fillingNotDetected"], framesManual: true })).get("frames")!;
    expect(f.state).toBe("done");
    expect(f.note?.key).toBe("qlv.step.note.framesManual");
  });

  it("自動提案のままなら「未確認」と名乗る", () => {
    expect(byId(qlv()).get("frames")?.note?.key).toBe("qlv.step.note.framesAuto");
  });

  it("点が足りない輪郭は invalid（黙って結果を出さない）", () => {
    const e = byId(qlv({ edPoints: 2, hasResult: false })).get("edContour")!;
    expect(e.state).toBe("invalid");
    expect(e.reasonKey).toBe("qlv.step.reason.tooFewPoints");
  });

  it("輪郭が未着手なら todo（点数は注記に出る）", () => {
    const m = byId(qlv({ edPoints: 0, hasResult: false }));
    expect(m.get("edContour")?.state).toBe("active");
    expect(byId(qlv()).get("edContour")?.note).toEqual({ key: "qlv.step.note.points", params: { n: "8" } });
  });

  it("active は高々 1 つ", () => {
    const cases: Partial<QlvTaskState>[] = [
      {}, { hasFrames: false }, { calibrated: false }, { edPoints: 0, hasResult: false },
      { esPoints: 0, hasResult: false }, { hasResult: false }, { saved: true }, { canSave: false },
      { frameWarnings: ["shortWindow"] },
    ];
    for (const c of cases) {
      expect(deriveQlvSteps(qlv(c)).filter((x) => x.state === "active").length).toBeLessThanOrEqual(1);
    }
  });

  it("🚨 ED/ES をやり直すと両方の輪郭を捨てる（別の心位相を指すため）", () => {
    const keys = clearedBy("frames", QLV_STEPS);
    expect(keys).toContain("edContour");
    expect(keys).toContain("esContour");
  });

  it("校正のやり直しは輪郭を捨てない（画素座標なので意味を失わない）", () => {
    expect(clearedBy("calibration", QLV_STEPS)).toEqual([]);
  });

  it("ED の輪郭をやり直しても ES は残る", () => {
    expect(clearedBy("edContour", QLV_STEPS)).toEqual(["edContour"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TIMI フレームカウント — `fw/angio-design.md` §24 / A15
// ─────────────────────────────────────────────────────────────────────────

function timiState(over: Partial<TimiTaskState> = {}): TimiTaskState {
  return {
    hasVessel: true,
    fpsSource: "frameTime",
    hasStart: true,
    hasEnd: true,
    endSelection: "manual",
    endBeforeStart: false,
    endAtLastFrame: false,
    endAtLastFrameConfirmed: false,
    hasResult: true,
    hasNormalised: true,
    canSave: false,
    saved: false,
    ...over,
  };
}

const timiById = (s: TimiTaskState) => new Map(deriveTimiSteps(s).map((x) => [x.id, x]));

describe("TIMI_STEPS の形", () => {
  it("根は vessel と rate の 2 つ（撮影レートは独立した入口）", () => {
    const order = TIMI_STEPS.map((s) => s.id);
    const targets = new Set(TIMI_STEPS.flatMap((s) => s.invalidates));
    expect(order.filter((id) => !targets.has(id))).toEqual(["vessel", "rate"]);
  });

  it("🔴 血管をやり直すと開始・到達を捨てる（別の入口部・別の指標点を指すため）", () => {
    expect(clearedBy("vessel", TIMI_STEPS)).toEqual(["vessel", "startFrame", "endFrame"]);
  });

  it("上流の手修正を捨てない", () => {
    // 到達をやり直しても、血管や開始は残る。
    expect(clearedBy("end", TIMI_STEPS)).toEqual(["endFrame"]);
    expect(clearedBy("start", TIMI_STEPS)).toEqual(["startFrame"]);
  });

  it("QLV の frames 鍵を流用していない（片方のやり直しでもう片方を消さない）", () => {
    const owned = TIMI_STEPS.flatMap((s) => s.owns);
    expect(owned).not.toContain("frames");
  });
});

describe("deriveTimiSteps", () => {
  it("血管が未選択なら vessel が active", () => {
    const steps = deriveTimiSteps(timiState({ hasVessel: false }));
    expect(steps.find((s) => s.id === "vessel")!.state).toBe("active");
  });

  it("🔴 撮影レートのタグが無ければ rate は skipped（done にしない）", () => {
    const st = timiById(timiState({ fpsSource: "default", hasNormalised: false })).get("rate")!;
    expect(st.state).toBe("skipped");
    expect(st.reasonKey).toBe("timi.step.reason.fpsUnknown");
  });

  it("撮影レートが分かっていれば done で、出自を注記に出す", () => {
    const st = timiById(timiState({ fpsSource: "frameTimeVector" })).get("rate")!;
    expect(st.state).toBe("done");
    expect(st.note?.key).toBe("cine.fpsSource.frameTimeVector");
  });

  it("到達 ≤ 開始 なら end が invalid", () => {
    const st = timiById(timiState({ endBeforeStart: true })).get("end")!;
    expect(st.state).toBe("invalid");
    expect(st.reasonKey).toBe("timi.step.reason.endBeforeStart");
  });

  it("🔴 到達が最終フレームなら、人が確認するまで invalid", () => {
    expect(timiById(timiState({ endAtLastFrame: true })).get("end")!.state).toBe("invalid");
    expect(
      timiById(timiState({ endAtLastFrame: true, endAtLastFrameConfirmed: true })).get("end")!.state,
    ).toBe("done");
  });

  it("到達の決め方を注記に出す（候補から採ったか手で入れたか）", () => {
    expect(timiById(timiState({ endSelection: "assisted" })).get("end")!.note?.key).toBe(
      "timi.step.note.assisted",
    );
    expect(timiById(timiState({ endSelection: "manual" })).get("end")!.note?.key).toBe(
      "timi.step.note.manual",
    );
  });

  it("換算できていない結果はその旨を注記に出す", () => {
    expect(timiById(timiState({ hasNormalised: false })).get("result")!.note?.key).toBe(
      "timi.step.note.rawOnly",
    );
  });

  it("保存は第 1 段では常に invalid（理由つきで並べる）", () => {
    const st = timiById(timiState()).get("save")!;
    expect(st.state).toBe("invalid");
    expect(st.reasonKey).toBe("timi.step.reason.srNotImplemented");
  });

  it("active は高々 1 つで、skipped を active にしない", () => {
    const steps = deriveTimiSteps(
      timiState({ fpsSource: "default", hasStart: false, hasEnd: false, hasResult: false }),
    );
    expect(steps.filter((s) => s.state === "active")).toHaveLength(1);
    expect(steps.find((s) => s.id === "rate")!.state).toBe("skipped");
    expect(steps.find((s) => s.state === "active")!.id).toBe("start");
  });
});
