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
  type Qca3dTaskState,
  QCA3D_STEPS,
  deriveQca3dSteps,
  QCA_STEPS,
  QLV_STEPS,
  clearedBy,
  deriveQcaSteps,
  deriveQlvSteps,
  invalidatedBy,
  type QcaTaskState,
  type QlvTaskState,
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

// ─────────────────────────────────────────────────────────────────────────
// QLV（左室造影）— `fw/angio-design.md` §9.2 / A5b
// ─────────────────────────────────────────────────────────────────────────

/** 段の繋がりの健全性は**タスクによらず**同じ規則で守る。 */
describe.each([
  ["QCA", QCA_STEPS],
  ["QLV", QLV_STEPS],
  ["3D QCA", QCA3D_STEPS],
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
// 3D QCA — `fw/angio-design.md` §10.2 / A6a
// ─────────────────────────────────────────────────────────────────────────

describe("deriveQca3dSteps", () => {
  function st(over: Partial<Qca3dTaskState> = {}): Qca3dTaskState {
    return {
      viewCount: 2,
      separationDeg: 75,
      minSeparationDeg: 30,
      anchorCount: 5,
      hasResult: true,
      acceptable: true,
      blockingWarning: null,
      refined: true,
      canSave: false,
      saved: false,
      ...over,
    };
  }
  const by = (s: Qca3dTaskState) => Object.fromEntries(deriveQca3dSteps(s).map((x) => [x.id, x]));

  it("方向が 1 つなら最初の段が active、後続は todo のまま", () => {
    const m = by(st({ viewCount: 1, separationDeg: null, hasResult: false }));
    expect(m.views.state).toBe("active");
    expect(m.anchors.state).toBe("todo");
    expect(m.recon.state).toBe("todo");
  });

  it("視点が近すぎれば方向の段が invalid になる", () => {
    const m = by(st({ separationDeg: 12, hasResult: false }));
    expect(m.views.state).toBe("invalid");
    expect(m.views.reasonKey).toBe("xa3d.step.reason.insufficientSeparation");
  });

  it("角度差は注記に数値で出る（『十分』とだけ言わない）", () => {
    expect(by(st()).views.note).toEqual({ key: "xa3d.step.note.separation", params: { deg: "75" } });
  });

  it("🚨 アンカーが端点 2 つだけなら done ではなく skipped", () => {
    // 2 点では角度補正が退化して掛けられない（§10.2.2）。「やった」と同じ顔にしない。
    const m = by(st({ anchorCount: 2 }));
    expect(m.anchors.state).toBe("skipped");
    expect(m.anchors.reasonKey).toBe("xa3d.step.reason.tooFewAnchors");
  });

  it("アンカーがゼロなら invalid（幾何を検算できない）", () => {
    const m = by(st({ anchorCount: 0 }));
    expect(m.anchors.state).toBe("invalid");
    expect(m.anchors.reasonKey).toBe("xa3d.step.reason.geometryUnverified");
  });

  it("結果が棄却されたら理由コードがそのまま段の理由になる", () => {
    const m = by(st({ acceptable: false, blockingWarning: "highReprojectionError" }));
    expect(m.recon.state).toBe("invalid");
    expect(m.recon.reasonKey).toBe("xa3d.step.reason.highReprojectionError");
  });

  it("補正が掛かったかどうかを注記で見分けられる", () => {
    expect(by(st({ refined: true })).recon.note).toEqual({ key: "xa3d.step.note.refined" });
    expect(by(st({ refined: false })).recon.note).toEqual({ key: "xa3d.step.note.notRefined" });
  });

  it("保存は未実装なので常に invalid（結果を出す前にそれが見える）", () => {
    expect(by(st()).save.state).toBe("invalid");
    expect(by(st()).save.reasonKey).toBe("xa3d.step.reason.saveNotImplemented");
  });

  it("方向をやり直すとアンカーも捨てる（別の 2 方向の画素座標になるため）", () => {
    expect(clearedBy("views", QCA3D_STEPS)).toEqual(["views", "anchors"]);
    expect(invalidatedBy("views", QCA3D_STEPS)).toEqual(["anchors", "recon", "save"]);
  });
});
