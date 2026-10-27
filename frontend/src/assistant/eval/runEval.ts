/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 回帰評価の実行。固定質問ごとに、実在のツール定義とシステムプロンプトで既存の `runToolLoop` を回す。
// 🔴 ビューアは**合成の状態を返すスタブ**で、操作は記録するだけ（実際の 2D 窓は動かさない）。送るのは合成の質問とツール定義だけ。
import type { AiChatMessage, AiChatResult } from "../../desktopBridge";
import { GET_MEASUREMENTS_TOOL, GET_STATE_TOOL, PROPOSE_TOOL, type ActionResult, type ToolDef } from "../actions/registry";
import { runToolLoop } from "../toolLoop";
import type { EvalCase } from "./cases";
import { scoreCase, type GotCall } from "./scoreCase";

/** 質問に答えるための合成の状態（CT・43 枚・ウィンドウ 40/400・1 列）。実際のビューアの値ではない。 */
export const SYNTHETIC_STATE: Record<string, unknown> = {
  tiles: [{ id: "t1", modality: "CT", sliceIndex: 0, sliceCount: 43, window: { center: 40, width: 400 }, zoom: 1, rotation: 0 }],
  layout: { cols: 1 },
  activeTool: "windowLevel",
};
export const SYNTHETIC_MEASUREMENTS: Record<string, unknown> = {
  rois: [{ label: "ROI 1", kind: "ellipse", areaMm2: 412.5, mean: 38.2, sd: 11.1, unit: "HU" }],
};

export interface CaseResult {
  id: string;
  /** 期待どおりに呼ばれたか。チャット自体が失敗した質問は false（`error` が入る）。 */
  pass: boolean;
  got: string[];
  reason?: string;
  error?: string;
}

export interface EvalRun {
  total: number;
  passed: number;
  cases: CaseResult[];
  /** 実行中の会話結果から取った由来（取れなければ null＝不明）。 */
  meta: { provider: string | null; modelId: string | null; modelVersion: string | null };
}

export interface EvalDeps {
  cases: readonly EvalCase[];
  systemPrompt: string;
  tools: ToolDef[];
  /** 1 往復。`sessionId` は質問ごとに別（`eval-…`）。 */
  chat: (sessionId: string, messages: AiChatMessage[], tools: ToolDef[]) => Promise<AiChatResult>;
  onProgress?: (done: number, total: number) => void;
  aborted?: () => boolean;
  runId?: string;
}

export async function runEval(d: EvalDeps): Promise<EvalRun> {
  const meta: EvalRun["meta"] = { provider: null, modelId: null, modelVersion: null };
  const results: CaseResult[] = [];
  const runId = d.runId ?? Date.now().toString(36);
  for (let i = 0; i < d.cases.length; i++) {
    if (d.aborted?.()) break;
    const c = d.cases[i];
    const sessionId = `eval-${runId}-${i}`;
    const calls: GotCall[] = [];
    let chatError: string | undefined;
    const viewer = async (cmd: { kind: string; id?: string; params?: unknown }): Promise<ActionResult> => {
      if (cmd.kind === "getState") return { ok: true, state: SYNTHETIC_STATE };
      if (cmd.kind === "getMeasurements") return { ok: true, measurements: SYNTHETIC_MEASUREMENTS };
      return { ok: true };
    };
    const res = await runToolLoop(
      [
        { role: "system", text: d.systemPrompt },
        { role: "user", text: c.text },
      ],
      d.tools,
      {
        mode: "chat",
        chat: async (messages, tools) => {
          const r = await d.chat(sessionId, messages, tools);
          if (r.ok) {
            meta.provider = r.provenance.providerId;
            meta.modelId = r.provenance.model;
            const v = (r as { modelVersion?: unknown }).modelVersion;
            if (typeof v === "string") meta.modelVersion = v;
          }
          return r;
        },
        viewer: viewer as never,
        onAction: (a) => {
          // 失敗（引数の検証落ち）も「呼んだ」ものとして数える。更新（done/failed の結果）は数えない。
          if (a.status === "running" || a.status === "failed" || a.name === GET_STATE_TOOL || a.name === GET_MEASUREMENTS_TOOL) {
            if (!calls.some((x) => (x as GotCall & { id?: string }).id === a.id)) calls.push({ name: a.name, args: (a.params as Record<string, unknown>) ?? {}, id: a.id } as GotCall);
          }
        },
        onActionUpdate: () => {},
        onProposal: (p) => calls.push({ name: PROPOSE_TOOL, args: { title: p.title }, id: p.id } as GotCall),
        onRoundDone: () => {},
        aborted: () => d.aborted?.() === true,
      },
    );
    if (!res.ok) chatError = res.error;
    const score = scoreCase(c, calls);
    results.push(chatError ? { id: c.id, pass: false, got: score.got, error: chatError } : { id: c.id, pass: score.pass, got: score.got, ...(score.reason ? { reason: score.reason } : {}) });
    d.onProgress?.(i + 1, d.cases.length);
  }
  return { total: results.length, passed: results.filter((r) => r.pass).length, cases: results, meta };
}
