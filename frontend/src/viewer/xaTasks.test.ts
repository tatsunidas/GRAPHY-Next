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
  QCA_STEPS,
  clearedBy,
  deriveQcaSteps,
  invalidatedBy,
  type QcaTaskState,
} from "./xaTasks";

const ORDER = QCA_STEPS.map((s) => s.id);

/** 既定は「入力あり・校正あり・解析済み・全部自動・保存可能」。各テストで必要な分だけ崩す。 */
function state(over: Partial<QcaTaskState> = {}): QcaTaskState {
  return {
    hasPick: true,
    calibrated: true,
    calibrationSource: "user-catheter",
    hasResult: true,
    waypoints: 0,
    editedEdges: 0,
    trimmed: false,
    referenceKind: "auto",
    edgeEditsDropped: false,
    canSave: true,
    saved: false,
    ...over,
  };
}

describe("段の繋がり", () => {
  it("id が重複していない", () => {
    expect(new Set(ORDER).size).toBe(ORDER.length);
  });

  it("invalidates の宛先がすべて実在する", () => {
    for (const s of QCA_STEPS) {
      for (const id of s.invalidates) expect(ORDER).toContain(id);
    }
  });

  it("巡回していない（自分自身に戻ってこない）", () => {
    for (const s of QCA_STEPS) {
      expect(invalidatedBy(s.id)).not.toContain(s.id);
    }
  });

  it("invalidates は必ず**後ろ**の段だけを指す", () => {
    // 前の段を無効にする辺があると「やり直すたびに前へ戻る」ループになり、
    // ユーザから見て終わらない。順序が前提の UI なのでここで固定する。
    for (const s of QCA_STEPS) {
      for (const id of s.invalidates) {
        expect(ORDER.indexOf(id)).toBeGreaterThan(ORDER.indexOf(s.id));
      }
    }
  });

  it("孤立した段が無い（入口以外は必ず誰かから無効化される）", () => {
    // 入口（＝誰からも無効化されない段）は **input と calibration の 2 つだけ**。
    // 校正は入力と独立した入口なので、根が 2 つあるのは意図的。ここを固定しておかないと
    // 「どこからも波及しない段」＝更新されずに古い結果を出し続ける段を作ってしまう。
    const targets = new Set(QCA_STEPS.flatMap((s) => s.invalidates));
    const roots = ORDER.filter((id) => !targets.has(id));
    expect(roots).toEqual(["input", "calibration"]);
  });

  it("最後の段は何も無効にしない", () => {
    expect(QCA_STEPS[QCA_STEPS.length - 1].invalidates).toEqual([]);
  });
});

describe("invalidatedBy（推移閉包）", () => {
  it("中心線を直すとエッジ・区間・保存が無効になる", () => {
    expect(invalidatedBy("centerline")).toEqual(["edges", "range", "save"]);
  });

  it("エッジを直しても中心線は無効にならない（設計 §21.2 の要求そのもの）", () => {
    const out = invalidatedBy("edges");
    expect(out).not.toContain("centerline");
    expect(out).toEqual(["range", "save"]);
  });

  it("返る順は段の表示順（Set の挿入順ではない）", () => {
    const out = invalidatedBy("input");
    expect(out).toEqual([...out].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
  });
});

describe("clearedBy（やり直しで捨てる手修正）", () => {
  it("手修正の持ち主が重複していない（1 つの値に段が 2 つあると判定が割れる）", () => {
    const owners = QCA_STEPS.flatMap((s) => s.owns);
    expect(new Set(owners).size).toBe(owners.length);
    expect(new Set(owners)).toEqual(new Set(["waypoints", "edges", "trim", "reference"]));
  });

  it("🚨 どの段も**上流が持つ**手修正を捨てない", () => {
    // 「エッジをやり直す」で通過点まで消えたら、ユーザから見て関係ない操作が巻き戻る。
    // 捨ててよいのは自分が持つものか、後続の段が持つものだけ。
    for (const s of QCA_STEPS) {
      for (const key of s.clears) {
        const ownerIdx = ORDER.indexOf(QCA_STEPS.find((x) => x.owns.includes(key))!.id);
        expect(ownerIdx).toBeGreaterThanOrEqual(ORDER.indexOf(s.id));
      }
    }
  });

  it("上流の手修正を捨てない（エッジのやり直しで通過点は残る）", () => {
    expect(clearedBy("edges")).not.toContain("waypoints");
  });

  it("中心線をやり直すとエッジ修正も捨てる（宛先が別の物理位置を指すため）", () => {
    const out = clearedBy("centerline");
    expect(out).toContain("waypoints");
    expect(out).toContain("edges");
  });

  it("解析からやり直すと手修正が全部消える（= 既存の「手修正をすべて破棄」と同じ）", () => {
    expect(new Set(clearedBy("analysis"))).toEqual(
      new Set(["waypoints", "edges", "trim", "reference"]),
    );
  });

  it("🚨 校正のやり直しは手修正を捨てない（実装バグをここで捕まえた）", () => {
    // 校正は解析結果を無効にするが、通過点やエッジ修正は**画素座標**なので生きている。
    // 最初の実装は `invalidates` を辿って `clears` を集めており、
    // 校正 → 解析 →（解析の clears＝全部）となって**校正し直すだけで手修正が全部消えた**。
    expect(invalidatedBy("calibration")).toContain("analysis");
    expect(clearedBy("calibration")).toEqual([]);
  });

  it("入力の選び直しも手修正を捨てない", () => {
    expect(clearedBy("input")).toEqual([]);
  });
});

describe("deriveQcaSteps", () => {
  const byId = (s: QcaTaskState) => new Map(deriveQcaSteps(s).map((x) => [x.id, x]));

  it("計測が無ければ入力が active", () => {
    const m = byId(state({ hasPick: false, hasResult: false }));
    expect(m.get("input")?.state).toBe("active");
    expect(m.get("analysis")?.state).toBe("todo");
  });

  it("🚨 未校正は done ではなく skipped（理由付き）", () => {
    const m = byId(state({ calibrated: false, calibrationSource: "none" }));
    const c = m.get("calibration");
    expect(c?.state).toBe("skipped");
    expect(c?.reasonKey).toBe("xa.step.reason.uncalibrated");
  });

  it("skipped は active にしない（飛ばした段を「次にやること」として指し続けない）", () => {
    const m = byId(state({ calibrated: false, hasResult: false }));
    expect(m.get("calibration")?.state).toBe("skipped");
    expect(m.get("analysis")?.state).toBe("active");
  });

  it("校正済みなら出自を注記に出す", () => {
    const m = byId(state({ calibrationSource: "dicom-fiducial" }));
    expect(m.get("calibration")?.state).toBe("done");
    expect(m.get("calibration")?.note?.key).toBe("xa.calib.source.dicom-fiducial");
  });

  it("自動のままの段は「自動」と注記される（人が確かめた値と区別する）", () => {
    const m = byId(state());
    expect(m.get("centerline")?.note?.key).toBe("xa.step.note.auto");
    expect(m.get("edges")?.note?.key).toBe("xa.step.note.auto");
    expect(m.get("range")?.note?.key).toBe("xa.step.note.auto");
  });

  it("手修正が入ると件数が注記に出る", () => {
    const m = byId(state({ waypoints: 2, editedEdges: 5, trimmed: true }));
    expect(m.get("centerline")?.note).toEqual({ key: "xa.step.note.waypoints", params: { n: "2" } });
    expect(m.get("edges")?.note).toEqual({ key: "xa.step.note.edges", params: { n: "5" } });
    expect(m.get("range")?.note?.key).toBe("xa.step.note.range");
  });

  it("エッジ修正が捨てられたら invalid（理由付き）", () => {
    const m = byId(state({ edgeEditsDropped: true }));
    expect(m.get("edges")?.state).toBe("invalid");
    expect(m.get("edges")?.reasonKey).toBe("xa.step.reason.edgeEditsDropped");
  });

  it("保存先が特定できなければ保存段は invalid", () => {
    const m = byId(state({ canSave: false }));
    expect(m.get("save")?.state).toBe("invalid");
    expect(m.get("save")?.reasonKey).toBe("xa.step.reason.noReference");
  });

  it("active はどの状態でも高々 1 つ", () => {
    const cases: Partial<QcaTaskState>[] = [
      {},
      { hasPick: false, hasResult: false },
      { calibrated: false },
      { hasResult: false },
      { saved: true },
      { canSave: false },
      { edgeEditsDropped: true },
      { hasPick: false, calibrated: false, hasResult: false, canSave: false },
    ];
    for (const c of cases) {
      const n = deriveQcaSteps(state(c)).filter((x) => x.state === "active").length;
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it("すべて済んだら active が無い", () => {
    const steps = deriveQcaSteps(state({ saved: true }));
    expect(steps.some((x) => x.state === "active")).toBe(false);
  });

  it("段の数と順序は定義どおり", () => {
    expect(deriveQcaSteps(state()).map((x) => x.id)).toEqual(ORDER);
  });
});
