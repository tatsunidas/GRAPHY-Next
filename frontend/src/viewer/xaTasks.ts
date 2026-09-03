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

/**
 * 手修正の実体（ダイアログの状態に対応）。
 * QCA（`waypoints`〜`reference`）と QLV（`frames`〜`esContour`）で共有する。
 */
export type ManualInputKey =
  | "waypoints"
  | "edges"
  | "trim"
  | "reference"
  | "frames"
  | "edContour"
  | "esContour"
  | "views"
  | "anchors"
  // TIMI（A15）。`frames` は QLV の ED/ES 用なので流用しない
  // （同じ鍵にすると、片方をやり直したときにもう片方の状態まで捨てる）。
  | "vessel"
  | "startFrame"
  | "endFrame";

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
  /** 参照径の決め方（`ends` は QVA の既定＝両端を健常と見なす）。 */
  referenceKind: "auto" | "segments" | "fixed" | "ends";
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

// ─────────────────────────────────────────────────────────────────────────
// QLV（左室造影）— `fw/angio-design.md` §9.2 / A5b
// ─────────────────────────────────────────────────────────────────────────

/**
 * QLV タスクの段。
 *
 * <p>QCA とは**必要な入力が違う**（ED/ES フレームの決定が要り、中心線・エッジは無い）。
 * 段をタスクごとの純データにしてある理由がここに出る（§21.2-3）。
 */
export const QLV_STEPS: readonly TaskStepDef[] = [
  {
    id: "frames",
    labelKey: "qlv.step.frames",
    // 🚨 輪郭は**特定のフレームの上に引いてある**。フレームを選び直したら、
    //    前のフレームに引いた輪郭は別の心位相を指すので捨てる（§21.6 と同じ理屈）。
    invalidates: ["edContour", "esContour"],
    owns: ["frames"],
    clears: ["frames", "edContour", "esContour"],
  },
  { id: "calibration", labelKey: "xa.step.calibration", invalidates: ["result"], owns: [], clears: [] },
  { id: "edContour", labelKey: "qlv.step.edContour", invalidates: ["result"], owns: ["edContour"], clears: ["edContour"] },
  { id: "esContour", labelKey: "qlv.step.esContour", invalidates: ["result"], owns: ["esContour"], clears: ["esContour"] },
  { id: "result", labelKey: "qlv.step.result", invalidates: ["save"], owns: [], clears: [] },
  { id: "save", labelKey: "xa.step.save", invalidates: [], owns: [], clears: [] },
] as const;

export interface QlvTaskState {
  /** ED/ES フレームが決まっているか。 */
  hasFrames: boolean;
  /** フレームを人が選び直したか（提案のままなら false）。 */
  framesManual: boolean;
  /** ED/ES 提案の警告（`fillingNotDetected` 等）。 */
  frameWarnings: readonly string[];
  /** mm を出してよい校正か。 */
  calibrated: boolean;
  calibrationSource: string | null;
  /** ED 輪郭の点数。 */
  edPoints: number;
  /** ES 輪郭の点数。 */
  esPoints: number;
  /** 輪郭として成立する最小点数。 */
  minPoints: number;
  hasResult: boolean;
  canSave: boolean;
  saved: boolean;
}

/**
 * QLV の段の状態を導出する。
 *
 * <p>🚨 **未校正の扱いが QCA と違う**。QCA では未校正だと数値そのものが px になるが、
 * QLV では **EF はスケール不変なので正しく出る**（容積 mL だけが出せない）。
 * 同じ `skipped` でも**理由の文言を変える**。「飛ばすと何が失われるか」がタスクで違うため。
 */
export function deriveQlvSteps(s: QlvTaskState): TaskStep[] {
  const steps: TaskStep[] = QLV_STEPS.map((def): TaskStep => {
    switch (def.id) {
      case "frames":
        if (!s.hasFrames) return { ...def, state: "todo" };
        if (s.frameWarnings.length > 0 && !s.framesManual) {
          // 提案の根拠が弱いのに人が確認していない。**黙って done にしない**。
          return { ...def, state: "invalid", reasonKey: `qlv.step.reason.${s.frameWarnings[0]}` };
        }
        return {
          ...def,
          state: "done",
          note: { key: s.framesManual ? "qlv.step.note.framesManual" : "qlv.step.note.framesAuto" },
        };

      case "calibration":
        return s.calibrated
          ? { ...def, state: "done", note: { key: `xa.calib.source.${s.calibrationSource ?? "none"}` } }
          : { ...def, state: "skipped", reasonKey: "qlv.step.reason.uncalibrated" };

      case "edContour":
      case "esContour": {
        const n = def.id === "edContour" ? s.edPoints : s.esPoints;
        if (n === 0) return { ...def, state: "todo" };
        if (n < s.minPoints) {
          return { ...def, state: "invalid", reasonKey: "qlv.step.reason.tooFewPoints" };
        }
        return { ...def, state: "done", note: { key: "qlv.step.note.points", params: { n: String(n) } } };
      }

      case "result":
        return { ...def, state: s.hasResult ? "done" : "todo" };

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

// ─────────────────────────────────────────────────────────────────────────
// 3D QCA — `fw/angio-design.md` §10.2 / A6a
// ─────────────────────────────────────────────────────────────────────────

/**
 * 3D QCA タスクの段。
 *
 * <p>QCA / QLV と違い、**この段は 1 枚の画像の上では完結しない**（2 方向が要る）。
 * だから最初の段が「方向を選ぶ」になっている。
 *
 * <p>保存の段は、品質基準を満たすまで `invalid` のまま。**保存できない理由を、結果を出す前に
 * 見せておく**（品質基準を満たさない結果は保存させない＝§10.3 の「無言で歪んだモデルを出さない」を
 * 保存物にも適用する）。
 */
export const QCA3D_STEPS: readonly TaskStepDef[] = [
  {
    id: "views",
    labelKey: "xa3d.step.views",
    // 🚨 アンカーは**特定の 2 方向の画素座標**なので、方向を選び直したら意味を失う。
    invalidates: ["anchors", "recon"],
    owns: ["views"],
    clears: ["views", "anchors"],
  },
  { id: "anchors", labelKey: "xa3d.step.anchors", invalidates: ["recon"], owns: ["anchors"], clears: ["anchors"] },
  { id: "recon", labelKey: "xa3d.step.recon", invalidates: ["save"], owns: [], clears: [] },
  { id: "save", labelKey: "xa.step.save", invalidates: [], owns: [], clears: [] },
] as const;

export interface Qca3dTaskState {
  /** 選べている方向の数（0〜2）。 */
  viewCount: number;
  /** 2 方向の視線がなす角 [deg]。未選択なら null。 */
  separationDeg: number | null;
  minSeparationDeg: number;
  /** アンカーの数（端点 2 つを含む）。 */
  anchorCount: number;
  hasResult: boolean;
  acceptable: boolean;
  /** 結果を止めている警告コード（`ReconWarningCode`）。 */
  blockingWarning: string | null;
  /** 角度補正が掛かったか。 */
  refined: boolean;
  /** 保存できるか（品質基準を満たし、2 方向の元インスタンスが分かっている）。 */
  canSave: boolean;
  saved: boolean;
}

/**
 * 3D QCA の段の状態を導出する。
 *
 * <p>🚨 **アンカーが端点 2 つだけの状態を `done` にしない。** 2 点では角度補正が退化して
 * 掛けられず（§10.2.2）、装置の機械誤差がそのまま形の歪みになる。**「飛ばした」として出す** ——
 * §21.6 の「未校正を done と同じ顔で出さない」と同じ話で、こちらのほうが害が大きい
 * （未校正なら単位が px になって気付けるが、こちらは**もっともらしい mm が出る**）。
 */
export function deriveQca3dSteps(s: Qca3dTaskState): TaskStep[] {
  const steps: TaskStep[] = QCA3D_STEPS.map((def): TaskStep => {
    switch (def.id) {
      case "views":
        if (s.viewCount < 2) return { ...def, state: "todo" };
        if (s.separationDeg != null && s.separationDeg < s.minSeparationDeg) {
          return { ...def, state: "invalid", reasonKey: "xa3d.step.reason.insufficientSeparation" };
        }
        return {
          ...def,
          state: "done",
          note: {
            key: "xa3d.step.note.separation",
            params: { deg: s.separationDeg != null ? s.separationDeg.toFixed(0) : "?" },
          },
        };

      case "anchors":
        if (s.viewCount < 2) return { ...def, state: "todo" };
        if (s.anchorCount === 0) {
          return { ...def, state: "invalid", reasonKey: "xa3d.step.reason.geometryUnverified" };
        }
        if (s.anchorCount < 3) {
          return { ...def, state: "skipped", reasonKey: "xa3d.step.reason.tooFewAnchors" };
        }
        return { ...def, state: "done", note: { key: "xa3d.step.note.anchors", params: { n: String(s.anchorCount) } } };

      case "recon":
        if (!s.hasResult) return { ...def, state: "todo" };
        if (!s.acceptable) {
          return { ...def, state: "invalid", reasonKey: `xa3d.step.reason.${s.blockingWarning ?? "rejected"}` };
        }
        return {
          ...def,
          state: "done",
          note: { key: s.refined ? "xa3d.step.note.refined" : "xa3d.step.note.notRefined" },
        };

      case "save":
        if (!s.canSave) return { ...def, state: "invalid", reasonKey: "xa3d.step.reason.saveNotImplemented" };
        return { ...def, state: s.saved ? "done" : "todo" };

      default:
        return { ...def, state: "todo" };
    }
  });

  const first = steps.find((x) => x.state === "todo");
  if (first) first.state = "active";
  return steps;
}

/* ------------------------------------------------------------------ */
/* TIMI フレームカウント（A15）                                        */
/* ------------------------------------------------------------------ */

/**
 * TIMI タスクの段。**根は `vessel` と `rate` の 2 本**（QCA の `input` / `calibration` と同じ形）。
 *
 * <p>🔴 **`rate`（撮影レート）は人が触れない導出値**だが段として並べる。
 * 撮影レートのタグが無いと**換算値を出せない**ので、「なぜ数字が出ないか」を
 * ここで説明する必要がある。校正（`calibration`）と同じ役回り。
 */
export const TIMI_STEPS: readonly TaskStepDef[] = [
  {
    id: "vessel",
    labelKey: "timi.step.vessel",
    // 🚨 血管が変われば**入口部も指標点も別の場所**になる。前に選んだフレームは
    //    別の物を指すので捨てる（QLV がフレームを変えたら輪郭を捨てるのと同じ理屈）。
    invalidates: ["start", "end"],
    owns: ["vessel"],
    clears: ["vessel", "startFrame", "endFrame"],
  },
  { id: "rate", labelKey: "timi.step.rate", invalidates: ["result"], owns: [], clears: [] },
  { id: "start", labelKey: "timi.step.start", invalidates: ["result"], owns: ["startFrame"], clears: ["startFrame"] },
  { id: "end", labelKey: "timi.step.end", invalidates: ["result"], owns: ["endFrame"], clears: ["endFrame"] },
  { id: "result", labelKey: "timi.step.result", invalidates: ["save"], owns: [], clears: [] },
  { id: "save", labelKey: "xa.step.save", invalidates: [], owns: [], clears: [] },
] as const;

/** {@link deriveTimiSteps} の入力。**UI の状態をそのまま写したもの**。 */
export interface TimiTaskState {
  /** 血管を選んだか。選ぶまで結果を出さない（何を測ったか決まらないため）。 */
  hasVessel: boolean;
  /** 撮影レートの出自。`"default"` は**タグが無い**＝換算値を出せない。 */
  fpsSource: string;
  /** 開始フレームを決めたか。 */
  hasStart: boolean;
  /** 到達フレームを決めたか。 */
  hasEnd: boolean;
  /** 到達の決め方（候補を押したか、手で入れたか）。出自として注記に出す。 */
  endSelection: "manual" | "assisted" | null;
  /** 到達 ≤ 開始。 */
  endBeforeStart: boolean;
  /** 到達がランの最終フレーム＝造影が途中で切れている可能性。 */
  endAtLastFrame: boolean;
  /** 最終フレームでよいと人が確認したか。 */
  endAtLastFrameConfirmed: boolean;
  /** 結果があるか。 */
  hasResult: boolean;
  /** 換算値（TFC30）を出せたか。撮影レート不明なら false。 */
  hasNormalised: boolean;
  /** 保存できるか（第 1 段では常に false）。 */
  canSave: boolean;
  saved: boolean;
}

/**
 * 段の状態を導出する。
 *
 * <p>🔑 QLV と違い「**自動提案のまま `done`**」の経路が無い。開始フレームには候補を出さず、
 * 到達の候補も人が押すまで入らないため（§24.1）。
 */
export function deriveTimiSteps(s: TimiTaskState): TaskStep[] {
  const steps: TaskStep[] = TIMI_STEPS.map((def): TaskStep => {
    switch (def.id) {
      case "vessel":
        return s.hasVessel ? { ...def, state: "done" } : { ...def, state: "todo" };

      case "rate":
        // 🔴 既定値に落ちている＝測っていない。`done` にせず `skipped` にする
        //    （「撮影レートが分かった」と読ませない）。
        return s.fpsSource === "default"
          ? { ...def, state: "skipped", reasonKey: "timi.step.reason.fpsUnknown" }
          : { ...def, state: "done", note: { key: `cine.fpsSource.${s.fpsSource}` } };

      case "start":
        if (!s.hasStart) return { ...def, state: "todo" };
        return { ...def, state: "done", note: { key: "timi.step.note.manual" } };

      case "end": {
        if (!s.hasEnd) return { ...def, state: "todo" };
        if (s.endBeforeStart) {
          return { ...def, state: "invalid", reasonKey: "timi.step.reason.endBeforeStart" };
        }
        if (s.endAtLastFrame && !s.endAtLastFrameConfirmed) {
          // 造影が途中で切れている可能性。人が確認するまで結果を出さない。
          return { ...def, state: "invalid", reasonKey: "timi.step.reason.endAtLastFrame" };
        }
        return {
          ...def,
          state: "done",
          note: { key: s.endSelection === "assisted" ? "timi.step.note.assisted" : "timi.step.note.manual" },
        };
      }

      case "result":
        if (!s.hasResult) return { ...def, state: "todo" };
        return s.hasNormalised
          ? { ...def, state: "done" }
          : { ...def, state: "done", note: { key: "timi.step.note.rawOnly" } };

      case "save":
        if (!s.canSave) return { ...def, state: "invalid", reasonKey: "timi.step.reason.srNotImplemented" };
        return { ...def, state: s.saved ? "done" : "todo" };

      default:
        return { ...def, state: "todo" };
    }
  });

  const first = steps.find((x) => x.state === "todo");
  if (first) first.state = "active";
  return steps;
}
