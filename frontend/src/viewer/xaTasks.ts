/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析タスクの「段（ステップ）」モデル（`fw/angio-design.md` §21.6・A13-1）。
 *
 * <h3>なぜ要るか</h3>
 * QCA は 7 段あるのに、UI では**いま何段目にいて何が未確定かが分からない**。
 * 特に困るのは次の 2 つで、どちらも「数値は出ているのに信用してよいか分からない」形で出る:
 * - **未校正のまま解析すると px で出る**。結果表を見ただけでは mm との区別が付きにくい
 * - **自動の中心線は血管から外れていても必ず結果を出す**（§8.6）。誰も見ていない自動値と、
 *   人が確かめた値が同じ顔をしている
 *
 * <h3>設計上の約束</h3>
 * 1. **状態を二重に持たない。** 段の状態は UI の状態（結果があるか・手修正が入っているか）から
 *    **毎回導出する**（{@link deriveQcaSteps}）。段側にフラグを持たせると必ず実体とずれる。
 * 2. **`skipped` を `done` と同じに見せない。** 「やった」と「飛ばした」が同じ見た目になると、
 *    **未校正のまま出た数値が承認済みに見える**（§21.6 の警告）。色も文言も分ける。
 * 3. **`invalidates` は「直接の依存」だけ書く。** 推移的な波及は {@link invalidatedBy} が閉包を取る。
 *    段を足すたびに全組合せを書くと、必ずどこかが漏れる。
 *
 * <p>ここは**純ロジック**（React 非依存）。段の繋がりが壊れていないことは vitest で守る
 * （巡回が無い・全段が到達可能・`clears` が上流を消さない）。UI を起動せずに検査できる。
 */

/** 段の状態。`fw/angio-design.md` §21.6。 */
export type TaskStepState =
  /** まだ実施していない。 */
  | "todo"
  /** いま実施すべき段（`todo` のうち先頭の 1 つだけ）。 */
  | "active"
  /** 結果がある。 */
  | "done"
  /** 実施できない／結果が信用できない。`reasonKey` を必ず伴う。 */
  | "invalid"
  /** **意図的に飛ばした**。`done` と混ぜないこと（未校正のまま進んだ場合がこれ）。 */
  | "skipped";

/** UI に出す短い注記（i18n キー＋引数）。 */
export interface TaskStepNote {
  key: string;
  params?: Record<string, string>;
}

/** 段の定義（静的）。 */
export interface TaskStepDef {
  id: string;
  /** 見出しの i18n キー。 */
  labelKey: string;
  /**
   * この段をやり直したとき、**直接**無効になる後続の段。
   * 推移的な波及は {@link invalidatedBy} が計算するので、ここに書かない。
   */
  invalidates: readonly string[];
  /**
   * この段が**持ち主**である手修正。「上流を消していないか」の検査に使う。
   */
  owns: readonly ManualInputKey[];
  /**
   * この段を「やり直す」ときに捨てる手修正。
   *
   * <p>⚠️ **`invalidates` に沿って伝播させないこと。** 「結果を計算し直す必要がある」と
   * 「人が入れた値を捨ててよい」は**別物**である。伝播させると、校正をやり直しただけで
   * （校正 → 解析 → …と辿って）**手修正が全部消える**。実際に最初の実装がそうなっていて、
   * テストで捕まえた。手修正が意味を失うのは「それが指しているものが変わったとき」だけで、
   * それは辺の性質ではなく段ごとの事実なので、**ここに明示的に書く**。
   *
   * <p>⚠️ **上流の入力を捨てないこと**（{@link owns} との突き合わせでテストが検査する）。
   * やり直しのつもりで上流を消すと、ユーザには「関係ない操作が巻き戻った」としか見えない。
   */
  clears: readonly ManualInputKey[];
}

/** 手修正の実体（`XaAnalysisDialog` の状態に対応）。 */
export type ManualInputKey = "waypoints" | "edges" | "trim" | "reference";

/** 導出された段（表示用）。 */
export interface TaskStep extends TaskStepDef {
  state: TaskStepState;
  note?: TaskStepNote;
  /** `invalid` / `skipped` の理由（i18n キー）。 */
  reasonKey?: string;
}

/**
 * QCA タスクの段。**表示順＝この配列の順**。
 *
 * <p>段の切り方は §8.1 の 7 段（アルゴリズムの段）そのままではなく、
 * **人が決める単位**にしてある（人が触れない段を並べても意味が無い）。
 */
export const QCA_STEPS: readonly TaskStepDef[] = [
  { id: "input", labelKey: "xa.step.input", invalidates: ["analysis"], owns: [], clears: [] },
  // 校正は入力とは独立した入口（先に校正してから計測を引いてもよい）。だから `input` から
  // 辺が出ていない。**根が 2 つある**のは意図的で、テストでもそれを固定している。
  { id: "calibration", labelKey: "xa.step.calibration", invalidates: ["analysis"], owns: [], clears: [] },
  {
    id: "analysis",
    labelKey: "xa.step.analysis",
    invalidates: ["centerline", "edges"],
    owns: [],
    // 「解析からやり直す」＝全部自動に戻す（既存の「手修正をすべて破棄」と同じ）。
    clears: ["waypoints", "edges", "trim", "reference"],
  },
  {
    id: "centerline",
    labelKey: "xa.step.centerline",
    // 🚨 中心線が変わるとエッジ修正の宛先（path インデックス）が**範囲内のまま別の物理位置**を
    //    指す。だから centerline → edges は必須（§8.6 の centerlineToken と同じ話）。
    invalidates: ["edges", "range"],
    owns: ["waypoints"],
    // 同じ理由で、中心線をやり直すときはエッジ修正も捨てる（指し先が無意味になるため）。
    clears: ["waypoints", "edges"],
  },
  { id: "edges", labelKey: "xa.step.edges", invalidates: ["range"], owns: ["edges"], clears: ["edges"] },
  {
    id: "range",
    labelKey: "xa.step.range",
    invalidates: ["save"],
    owns: ["trim", "reference"],
    clears: ["trim", "reference"],
  },
  { id: "save", labelKey: "xa.step.save", invalidates: [], owns: [], clears: [] },
] as const;

/**
 * `from` をやり直したときに無効になる段（**推移閉包**。`from` 自身は含まない）。
 *
 * <p>幅優先で辿るだけ。巡回があっても止まる（`seen` で刈る）が、**巡回はテストで禁止**している。
 */
export function invalidatedBy(from: string, steps: readonly TaskStepDef[] = QCA_STEPS): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue = [...(byId.get(from)?.invalidates ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of byId.get(id)?.invalidates ?? []) queue.push(next);
  }
  // 表示順を保つ（Set の挿入順ではなく段の順）。
  return steps.filter((s) => seen.has(s.id)).map((s) => s.id);
}

/**
 * `from` を「やり直す」ときに捨てる手修正の一覧。
 *
 * <p>🚨 **`invalidates` を辿らない。** 「無効（計算し直す）」と「捨てる（人の入力を消す）」は
 * 別物で、辿ると校正のやり直しだけで手修正が全部消える（{@link TaskStepDef.clears} 参照）。
 */
export function clearedBy(from: string, steps: readonly TaskStepDef[] = QCA_STEPS): ManualInputKey[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return [...(byId.get(from)?.clears ?? [])];
}

/** {@link deriveQcaSteps} の入力。**UI の状態をそのまま写したもの**（新しい状態を増やさない）。 */
export interface QcaTaskState {
  /** 入力の Length 計測を選べているか。 */
  hasPick: boolean;
  /** mm を出してよい校正か（`isXaCalibrated()` の結果）。 */
  calibrated: boolean;
  /** 校正の出自（`XaCalibration.source`）。`done` の注記に出す。 */
  calibrationSource: string | null;
  /** 解析結果があるか。 */
  hasResult: boolean;
  /** 手修正の通過点の数。 */
  waypoints: number;
  /** 手修正したエッジの数。 */
  editedEdges: number;
  /** 区間を切り詰めたか。 */
  trimmed: boolean;
  /** 参照径の決め方。 */
  referenceKind: "auto" | "segments" | "fixed";
  /** 中心線が変わってエッジ修正が捨てられたか（`warnings` に `edgeEditsDropped`）。 */
  edgeEditsDropped: boolean;
  /** 保存先の元インスタンスを特定できているか。 */
  canSave: boolean;
  /** 保存済みか。 */
  saved: boolean;
}

/**
 * UI の状態から段の状態を導出する。**ここが唯一の判定**（各所で個別に判定しない）。
 *
 * <p>`active` は「`todo` のうち最初の 1 つ」。`skipped` / `invalid` は `active` にしない
 * （飛ばした段を「次にやること」として指し続けると、ずっと前に進めないように見える）。
 */
export function deriveQcaSteps(s: QcaTaskState): TaskStep[] {
  const steps: TaskStep[] = QCA_STEPS.map((def): TaskStep => {
    switch (def.id) {
      case "input":
        return { ...def, state: s.hasPick ? "done" : "todo" };

      case "calibration":
        // 🚨 未校正は `todo` ではなく **`skipped`**。「まだやっていない」ではなく
        //    「やらずに進める（＝px で出る）」が起きうる段なので、飛ばした事実として出す。
        return s.calibrated
          ? {
              ...def,
              state: "done",
              note: { key: `xa.calib.source.${s.calibrationSource ?? "none"}` },
            }
          : { ...def, state: "skipped", reasonKey: "xa.step.reason.uncalibrated" };

      case "analysis":
        return { ...def, state: s.hasResult ? "done" : "todo" };

      case "centerline":
        if (!s.hasResult) return { ...def, state: "todo" };
        return {
          ...def,
          state: "done",
          // 「自動のまま」と「人が直した」を必ず見分けられるようにする。
          note:
            s.waypoints > 0
              ? { key: "xa.step.note.waypoints", params: { n: String(s.waypoints) } }
              : { key: "xa.step.note.auto" },
        };

      case "edges":
        if (!s.hasResult) return { ...def, state: "todo" };
        if (s.edgeEditsDropped) {
          return { ...def, state: "invalid", reasonKey: "xa.step.reason.edgeEditsDropped" };
        }
        return {
          ...def,
          state: "done",
          note:
            s.editedEdges > 0
              ? { key: "xa.step.note.edges", params: { n: String(s.editedEdges) } }
              : { key: "xa.step.note.auto" },
        };

      case "range":
        if (!s.hasResult) return { ...def, state: "todo" };
        return {
          ...def,
          state: "done",
          note:
            s.trimmed || s.referenceKind !== "auto"
              ? {
                  key: "xa.step.note.range",
                  params: { reference: s.referenceKind, trim: s.trimmed ? "1" : "0" },
                }
              : { key: "xa.step.note.auto" },
        };

      case "save":
        if (!s.canSave) return { ...def, state: "invalid", reasonKey: "xa.step.reason.noReference" };
        return { ...def, state: s.saved ? "done" : "todo" };

      default:
        return { ...def, state: "todo" };
    }
  });

  const first = steps.find((x) => x.state === "todo");
  if (first) first.state = "active";
  return steps;
}
