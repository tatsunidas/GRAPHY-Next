/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// ロボットモードの計画パネル（アシスタント窓）。モデルが出した計画を利用者が確認・絞り込んで「実行」するまで、
// 何も動かさない。実行は S5a のマクロと同じ runMacro（全ステップを先に検証・失敗で停止・中止・逆順の取り消し）。
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { InverseStep } from "../actions/registry";
import { MAX_NAME, checkSteps, type MacroStep } from "../macros/macroModel";
import { stepLabel, type MacroApi } from "../macros/MacroPanel";
import { runMacro, undoRun } from "../macros/runMacro";

type T = (k: string, v?: Record<string, string | number>) => string;

export interface RobotPlan {
  id: string;
  title: string;
  steps: MacroStep[];
}

export interface JournalEntry {
  ts: string;
  id: string;
  params?: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface RobotApi {
  viewer: MacroApi["viewer"];
  save?: MacroApi["save"];
  journal?: () => Promise<{ ok: boolean; entries?: JournalEntry[] }>;
}

type Phase = "review" | "running" | "finished";

export function RobotPanel({ plan, api, t, onDiscard }: { plan: RobotPlan | null; api: RobotApi; t: T; onDiscard: () => void }) {
  const [picked, setPicked] = useState<boolean[]>([]);
  const [phase, setPhase] = useState<Phase>("review");
  const [cur, setCur] = useState(-1);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [inverses, setInverses] = useState<InverseStep[][] | null>(null);
  const [history, setHistory] = useState<JournalEntry[] | null>(null);
  const abortRef = useRef(false);

  // 新しい計画が来たら、確認の状態からやり直す（実行中に差し替わることは無い: 実行中は送信できない）。
  useEffect(() => {
    setPicked(plan ? plan.steps.map(() => true) : []);
    setPhase("review");
    setCur(-1);
    setMsg(null);
    setInverses(null);
  }, [plan]);

  const loadHistory = useCallback(async () => {
    const r = await api.journal?.();
    setHistory(r?.ok && r.entries ? r.entries : []);
  }, [api]);

  if (!plan && history === null && !api.journal) return null;
  const chosen = plan ? plan.steps.filter((_, i) => picked[i]) : [];

  const run = async () => {
    if (!plan) return;
    const chk = checkSteps(chosen);
    if (!chk.ok) return setMsg({ kind: "err", text: t("assistant.robot.needSteps") });
    setMsg(null);
    abortRef.current = false;
    setPhase("running");
    const out = await runMacro(chk.steps, { viewer: api.viewer, aborted: () => abortRef.current, onStep: setCur });
    setCur(-1);
    setPhase("finished");
    setInverses(out.inverses.length ? out.inverses : null);
    if (out.status === "done") setMsg({ kind: "ok", text: t("assistant.robot.ran", { n: out.executed }) });
    else if (out.status === "aborted") setMsg({ kind: "err", text: t("assistant.robot.aborted", { n: out.executed }) });
    else setMsg({ kind: "err", text: t("assistant.robot.failed", { step: out.failedAt === undefined ? "-" : out.failedAt + 1, error: out.error ?? "?" }) });
    if (api.journal) void loadHistory();
  };

  const undo = async () => {
    if (!inverses) return;
    const r = await undoRun(inverses, api.viewer);
    if (!r.ok) return setMsg({ kind: "err", text: t("assistant.robot.undoFailed", { error: r.error }) });
    setInverses(null);
    setMsg({ kind: "ok", text: r.skipped ? t("assistant.robot.undoneSome", { n: r.skipped }) : t("assistant.robot.undone") });
  };

  const saveMacro = async () => {
    if (!plan || !api.save) return;
    const chk = checkSteps(chosen);
    if (!chk.ok) return setMsg({ kind: "err", text: t("assistant.robot.needSteps") });
    const r = await api.save({ name: plan.title.slice(0, MAX_NAME), steps: chk.steps });
    setMsg(r.ok ? { kind: "ok", text: t("assistant.robot.savedMacro") } : { kind: "err", text: t("assistant.macro.saveFailed", { error: r.error ?? "?" }) });
  };

  return (
    <div style={P.root} data-testid="assistant-robot-panel">
      <div style={P.row}>
        <strong style={{ flex: 1 }}>{t("assistant.robot.title")}</strong>
        {phase === "running" && (
          <button style={P.stop} onClick={() => (abortRef.current = true)} data-testid="assistant-robot-stop">{t("assistant.robot.stop")}</button>
        )}
      </div>
      {!plan ? (
        <div style={P.dim} data-testid="assistant-robot-empty">{t("assistant.robot.empty")}</div>
      ) : (
        <>
          <div data-testid="assistant-robot-plan-title">{plan.title}</div>
          <div style={P.dim}>{phase === "review" ? t("assistant.robot.review") : ""}</div>
          {plan.steps.map((s, i) => (
            <label key={i} style={{ ...P.row, ...(cur === i ? P.cur : null) }} data-testid="assistant-robot-step">
              <input
                type="checkbox"
                disabled={phase !== "review"}
                checked={!!picked[i]}
                onChange={(e) => setPicked((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
                data-testid="assistant-robot-pick"
              />
              {i + 1}. {stepLabel(t, s)}
            </label>
          ))}
          <div style={P.row}>
            {phase === "review" && (
              <>
                <button style={P.btnPrimary} disabled={chosen.length === 0} onClick={() => void run()} data-testid="assistant-robot-run">{t("assistant.robot.run")}</button>
                {api.save && <button style={P.btn} disabled={chosen.length === 0} onClick={() => void saveMacro()} data-testid="assistant-robot-save">{t("assistant.robot.saveMacro")}</button>}
                <button style={P.btn} onClick={onDiscard} data-testid="assistant-robot-discard">{t("assistant.robot.discard")}</button>
              </>
            )}
            {phase === "finished" && (
              <>
                {inverses && <button style={P.btn} onClick={() => void undo()} data-testid="assistant-robot-undo">{t("assistant.robot.undoAll")}</button>}
                <button style={P.btn} onClick={onDiscard} data-testid="assistant-robot-close">{t("assistant.robot.close")}</button>
              </>
            )}
          </div>
        </>
      )}
      {msg && <div style={msg.kind === "err" ? P.err : P.ok} data-testid="assistant-robot-msg">{msg.text}</div>}
      {api.journal && (
        <div style={P.history}>
          <button style={P.btn} onClick={() => void loadHistory()} data-testid="assistant-robot-history-btn">{t("assistant.robot.history")}</button>
          {history && history.length === 0 && <div style={P.dim}>{t("assistant.robot.historyEmpty")}</div>}
          {history?.map((h, i) => (
            <div key={i} style={P.dim} data-testid="assistant-robot-history-item">
              {h.ts.slice(11, 19)} {t(`assistant.act.${h.id}`)} {h.ok ? "✓" : `✗ ${h.error ?? ""}`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const P: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", borderTop: "1px solid #3a3b3f", background: "#26272b", fontSize: 12, maxHeight: "45vh", overflowY: "auto" },
  row: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  cur: { background: "#34507a", borderRadius: 4 },
  dim: { color: "#9aa0a6", overflowWrap: "anywhere" },
  history: { display: "flex", flexDirection: "column", gap: 3, borderTop: "1px solid #3a3b3f", paddingTop: 6 },
  btn: { padding: "3px 8px", borderRadius: 6, border: "1px solid #5f6368", background: "transparent", color: "inherit", cursor: "pointer" },
  btnPrimary: { padding: "3px 8px", borderRadius: 6, border: "none", background: "#2f5fa8", color: "#fff", cursor: "pointer" },
  stop: { padding: "4px 12px", borderRadius: 6, border: "none", background: "#c5221f", color: "#fff", cursor: "pointer", fontWeight: 600 },
  err: { color: "#f28b82", overflowWrap: "anywhere" },
  ok: { color: "#81c995" },
};
