/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 回帰評価の実行。固定質問ごとに、実在のツール定義とシステムプロンプトで既存の `runToolLoop` を回す。
// 🔴 ビューアは**合成の状態を返すスタブ**で、操作は記録するだけ（実際の 2D 窓は動かさない）。送るのは合成の質問とツール定義だけ。
import type { AiChatMessage, AiChatResult } from "../../desktopBridge";
import { GET_MEASUREMENTS_TOOL, GET_STATE_TOOL, PROPOSE_TOOL, type ActionResult, type ToolDef } from "../actions/registry";
import { runToolLoop } from "../toolLoop";
import { toToolDef, type PluginToolEntry } from "../pluginTools";
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
  /** k 回すべて期待どおりに呼ばれたか（`passes === n`）。チャット自体が失敗した回は不合格に数える（`error` が入る）。 */
  pass: boolean;
  /** 合格した回数と流した回数（k 回反復）。 */
  passes: number;
  n: number;
  got: string[];
  reason?: string;
  error?: string;
  /** 質問 1 回あたりの壁時間（ツール往復を含む、ms。k 回の平均）。チャットが失敗した回が 1 回でもあれば入れない。 */
  latencyMs?: number;
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
  /** 各質問を流す回数（既定 1）。 */
  k?: number;
  /** 組の合成プラグインツール。ツール一覧に足し、実行は viewer スタブが受ける。 */
  pluginTools?: readonly PluginToolEntry[];
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
  const k = Math.max(1, Math.floor(d.k ?? 1));
  const pluginTools = (d.pluginTools ?? []) as PluginToolEntry[];
  const tools = [...d.tools, ...pluginTools.map(toToolDef)];
  const total = d.cases.length * k;
  let done = 0;
  outer: for (let i = 0; i < d.cases.length; i++) {
    const c = d.cases[i];
    let passes = 0;
    let n = 0;
    let first: { got: string[]; reason?: string; error?: string } | undefined;
    const lat: number[] = [];
    let latMissing = false;
    let lastGot: string[] = [];
    for (let r = 0; r < k; r++) {
      if (d.aborted?.()) break outer;
      const sessionId = k === 1 ? `eval-${runId}-${i}` : `eval-${runId}-${i}-${r}`;
      const calls: GotCall[] = [];
      const t0 = performance.now();
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
        tools,
        {
          mode: "chat",
          chat: async (messages, ts) => {
            const resp = await d.chat(sessionId, messages, ts);
            if (resp.ok) {
              meta.provider = resp.provenance.providerId;
              meta.modelId = resp.provenance.model;
              const v = (resp as { modelVersion?: unknown }).modelVersion;
              if (typeof v === "string") meta.modelVersion = v;
            }
            return resp;
          },
          viewer: viewer as never,
          pluginTools,
          pluginTool: async () => ({ ok: true, source: "eval-synth", untrusted: true, data: {} }),
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
      const latencyMs = Math.round(performance.now() - t0);
      const score = scoreCase(c, calls);
      n++;
      lastGot = score.got;
      let ok = false;
      if (!res.ok) {
        latMissing = true;
        first ??= { got: score.got, error: res.error };
      } else {
        lat.push(latencyMs);
        ok = score.pass;
        if (!ok) first ??= { got: score.got, ...(score.reason ? { reason: score.reason } : {}) };
      }
      if (ok) passes++;
      done++;
      d.onProgress?.(done, total);
    }
    results.push({
      id: c.id,
      pass: passes === n,
      passes,
      n,
      got: first?.got ?? lastGot,
      ...(first?.reason ? { reason: first.reason } : {}),
      ...(first?.error ? { error: first.error } : {}),
      ...(!latMissing && lat.length ? { latencyMs: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) } : {}),
    });
  }
  return { total: results.length, passed: results.filter((r) => r.pass).length, cases: results, meta };
}
