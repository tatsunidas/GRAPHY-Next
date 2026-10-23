/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// マクロのパネル（アシスタント窓）。会話で実行できた操作から作る／保存済みを再生する／全部取り消す。
// 再生にモデルは要らない（オフラインでも動く）。
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ActionResult, InverseStep } from "../actions/registry";
import { MAX_NAME, checkSteps, type Macro, type MacroStep } from "./macroModel";
import { runMacro, undoRun } from "./runMacro";

type T = (k: string, v?: Record<string, string | number>) => string;

export interface MacroApi {
  list: () => Promise<{ ok: boolean; macros?: Macro[]; error?: string }>;
  save: (m: { name: string; steps: MacroStep[] }) => Promise<{ ok: boolean; macro?: Macro; error?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  viewer: (cmd: { kind: "action"; id: string; params: Record<string, unknown> }) => Promise<ActionResult>;
}

function stepLabel(t: T, s: MacroStep): string {
  const p = Object.entries(s.params).map(([k, v]) => `${k}=${String(v)}`).join(" ");
  return `${t(`assistant.act.${s.id}`)}${p ? ` ${p}` : ""}`;
}

export function MacroPanel({ api, candidates, busy, t }: { api: MacroApi; candidates: MacroStep[]; busy: boolean; t: T }) {
  const [macros, setMacros] = useState<Macro[]>([]);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<boolean[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<InverseStep[][] | null>(null);
  const abortRef = useRef(false);

  const reload = useCallback(async () => {
    const r = await api.list();
    setMacros(r.ok && r.macros ? r.macros : []);
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // 候補が変わったら全部選び直す。
  useEffect(() => {
    setPicked(candidates.map(() => true));
  }, [candidates]);

  const chosen = candidates.filter((_, i) => picked[i]);

  const save = async () => {
    setMsg(null);
    const n = name.trim();
    if (!n) return setMsg({ kind: "err", text: t("assistant.macro.needName") });
    const chk = checkSteps(chosen);
    if (!chk.ok) return setMsg({ kind: "err", text: t("assistant.macro.needSteps") });
    const r = await api.save({ name: n, steps: chk.steps });
    if (!r.ok) return setMsg({ kind: "err", text: t("assistant.macro.saveFailed", { error: r.error ?? "?" }) });
    setName("");
    setMsg({ kind: "ok", text: t("assistant.macro.saved") });
    await reload();
  };

  const run = async (m: Macro) => {
    setMsg(null);
    setLastRun(null);
    abortRef.current = false;
    setRunning(m.id);
    const out = await runMacro(m.steps, { viewer: api.viewer, aborted: () => abortRef.current });
    setRunning(null);
    if (out.inverses.length) setLastRun(out.inverses);
    if (out.status === "done") setMsg({ kind: "ok", text: t("assistant.macro.ran", { n: out.executed }) });
    else if (out.status === "aborted") setMsg({ kind: "err", text: t("assistant.macro.aborted", { n: out.executed }) });
    else setMsg({ kind: "err", text: t("assistant.macro.failed", { step: out.failedAt === undefined ? "-" : out.failedAt + 1, error: out.error ?? "?" }) });
  };

  const undo = async () => {
    if (!lastRun) return;
    const r = await undoRun(lastRun, api.viewer);
    if (!r.ok) return setMsg({ kind: "err", text: t("assistant.macro.undoFailed", { error: r.error }) });
    setLastRun(null);
    setMsg({ kind: "ok", text: r.skipped ? t("assistant.macro.undoneSome", { n: r.skipped }) : t("assistant.macro.undone") });
  };

  const remove = async (m: Macro) => {
    const r = await api.remove(m.id);
    if (!r.ok) setMsg({ kind: "err", text: t("assistant.macro.saveFailed", { error: r.error ?? "?" }) });
    await reload();
  };

  return (
    <div style={P.root} data-testid="assistant-macro-panel">
      <strong>{t("assistant.macro.title")}</strong>
      {macros.length === 0 ? (
        <div style={P.dim} data-testid="assistant-macro-empty">{t("assistant.macro.empty")}</div>
      ) : (
        macros.map((m) => (
          <div key={m.id} style={P.item} data-testid="assistant-macro-item">
            <div style={{ flex: "1 1 100%" }}>
              <span data-testid="assistant-macro-name">{m.name}</span> <span style={P.dim}>{t("assistant.macro.steps", { n: m.steps.length })}</span>
              <div style={P.dim}>{m.steps.map((s) => stepLabel(t, s)).join(" → ")}</div>
            </div>
            {running === m.id ? (
              <button style={P.btn} onClick={() => (abortRef.current = true)} data-testid="assistant-macro-abort">{t("assistant.macro.abort")}</button>
            ) : (
              <button style={P.btnPrimary} disabled={busy || running !== null} onClick={() => void run(m)} data-testid="assistant-macro-run">{t("assistant.macro.run")}</button>
            )}
            <button style={P.btn} disabled={running !== null} onClick={() => void remove(m)} data-testid="assistant-macro-delete">{t("assistant.macro.delete")}</button>
          </div>
        ))
      )}
      {lastRun && (
        <button style={P.btn} disabled={running !== null} onClick={() => void undo()} data-testid="assistant-macro-undo">{t("assistant.macro.undoAll")}</button>
      )}
      <div style={P.sep} />
      <div style={P.dim}>{t("assistant.macro.from")}</div>
      {candidates.length === 0 ? (
        <div style={P.dim} data-testid="assistant-macro-nocand">{t("assistant.macro.noCandidates")}</div>
      ) : (
        <>
          {candidates.map((s, i) => (
            <label key={i} style={P.row}>
              <input type="checkbox" checked={!!picked[i]} onChange={(e) => setPicked((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))} data-testid="assistant-macro-pick" />
              {stepLabel(t, s)}
            </label>
          ))}
          <div style={P.row}>
            <input
              style={P.input}
              value={name}
              maxLength={MAX_NAME}
              placeholder={t("assistant.macro.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              data-testid="assistant-macro-name-input"
            />
            <button style={P.btnPrimary} disabled={chosen.length === 0} onClick={() => void save()} data-testid="assistant-macro-save">{t("assistant.macro.save")}</button>
          </div>
        </>
      )}
      {msg && (
        <div style={msg.kind === "err" ? P.err : P.ok} data-testid="assistant-macro-msg">{msg.text}</div>
      )}
    </div>
  );
}

const P: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", borderTop: "1px solid #3a3b3f", background: "#26272b", fontSize: 12, maxHeight: "40vh", overflowY: "auto" },
  item: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "4px 6px", border: "1px solid #3a3b3f", borderRadius: 6 },
  row: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  dim: { color: "#9aa0a6", overflowWrap: "anywhere" },
  sep: { borderTop: "1px solid #3a3b3f", margin: "2px 0" },
  input: { flex: 1, minWidth: 120, padding: "4px 6px", borderRadius: 6, border: "1px solid #5f6368", background: "transparent", color: "inherit" },
  btn: { padding: "3px 8px", borderRadius: 6, border: "1px solid #5f6368", background: "transparent", color: "inherit", cursor: "pointer" },
  btnPrimary: { padding: "3px 8px", borderRadius: 6, border: "none", background: "#2f5fa8", color: "#fff", cursor: "pointer" },
  err: { color: "#f28b82", overflowWrap: "anywhere" },
  ok: { color: "#81c995" },
};
