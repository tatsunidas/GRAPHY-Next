/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// スキルのパネル（アシスタント窓）。一覧・詳細・実行（入力・確認つき）・停止・元に戻す・削除・書き出し/取り込み。
// 実行にモデルは要らない（オフラインでも動く）。開始は必ず利用者が押す。
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ActionResult, InverseStep } from "../actions/registry";
import { undoRun } from "../macros/runMacro";
import type { PluginToolEntry, PluginToolResult } from "../pluginTools";
import { BUNDLED_SKILLS } from "./bundled";
import { runSkill } from "./runSkill";
import { exportSkill, parseSkillText, pick, skillEffect, upFrontInputs, validateSkill, type Skill, type SkillEntry, type SkillInput } from "./skillModel";
import { initialText, mergeSkills, parseFieldText, stepSummary } from "./skillView";

type T = (k: string, v?: Record<string, string | number>) => string;

export interface SkillApi {
  list: () => Promise<{ ok: boolean; skills?: Skill[]; error?: string }>;
  save: (s: Skill) => Promise<{ ok: boolean; skill?: Skill; error?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  viewer: (cmd: { kind: "action"; id: string; params: Record<string, unknown> }) => Promise<ActionResult>;
  pluginTools?: readonly PluginToolEntry[];
  pluginTool?: (cmd: { kind: "pluginTool"; name: string; params: Record<string, unknown> }) => Promise<PluginToolResult>;
}

/** アシスタントからの提案・下書き（`nonce` が変わるたびに 1 件として扱う）。 */
export interface SkillSuggestion {
  nonce: number;
  skillId: string;
  inputs: Record<string, unknown>;
}
export interface SkillDraft {
  nonce: number;
  skill: Skill;
}

type Pending = { kind: "ask"; spec: SkillInput; text: string } | { kind: "confirm"; message: string };

export function SkillPanel({
  api,
  busy,
  t,
  locale,
  suggestion,
  draft,
  onChanged,
  reloadKey,
}: {
  api: SkillApi;
  busy: boolean;
  t: T;
  locale: string;
  suggestion?: SkillSuggestion | null;
  draft?: SkillDraft | null;
  onChanged?: () => void;
  /** 画面側でスキルが変わったら増える（マクロからの変換など）。変わったら一覧を読み直す。 */
  reloadKey?: number;
}) {
  const [user, setUser] = useState<Skill[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null); // 手順を開いているスキルの id
  const [form, setForm] = useState<{ entry: SkillEntry; text: Record<string, string>; suggested?: boolean } | null>(null);
  const [draftSkill, setDraftSkill] = useState<Skill | null>(null);
  const [running, setRunning] = useState<{ id: string; step: number; total: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [lastRun, setLastRun] = useState<InverseStep[][] | null>(null);
  const abortRef = useRef(false);
  const resolveRef = useRef<((v: unknown) => void) | null>(null);

  const reload = useCallback(async () => {
    const r = await api.list();
    setUser(r.ok && r.skills ? r.skills : []);
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const entries = mergeSkills(user);

  // アシスタントの開始の提案: 入力欄にモデルの値を入れた状態で出す。自動では開始しない。
  useEffect(() => {
    if (!suggestion) return;
    const entry = mergeSkills(user).find((e) => e.skill.id === suggestion.skillId);
    if (!entry) return setMsg({ kind: "err", text: t("assistant.skill.suggestGone") });
    setMsg(null);
    setForm({
      entry,
      suggested: true,
      text: Object.fromEntries(upFrontInputs(entry.skill).map((i) => [i.key, suggestion.inputs[i.key] !== undefined ? String(suggestion.inputs[i.key]) : initialText(i)])),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion?.nonce]);
  // 下書き: 保存するまで一覧にも main にも入らない。
  useEffect(() => {
    if (draft) setDraftSkill(draft.skill);
  }, [draft?.nonce]);

  const saveDraft = async () => {
    if (!draftSkill) return;
    const chk = validateSkill(draftSkill, api.pluginTools);
    if (!chk.ok) return setMsg({ kind: "err", text: t("assistant.skill.importFailed", { error: chk.error }) });
    const r = await api.save(chk.skill);
    if (!r.ok) return setMsg({ kind: "err", text: t("assistant.skill.importFailed", { error: r.error ?? "?" }) });
    setDraftSkill(null);
    setMsg({ kind: "ok", text: t("assistant.skill.imported", { name: pick(chk.skill.title, locale) }) });
    await reload();
    onChanged?.();
  };

  const begin = (entry: SkillEntry) => {
    setMsg(null);
    if (upFrontInputs(entry.skill).length) {
      setForm({ entry, text: Object.fromEntries(upFrontInputs(entry.skill).map((i) => [i.key, initialText(i)])) });
    } else void start(entry, {});
  };

  const start = async (entry: SkillEntry, values: Record<string, unknown>) => {
    setForm(null);
    setLastRun(null);
    abortRef.current = false;
    const sk = entry.skill;
    setRunning({ id: sk.id, step: 0, total: sk.steps.length });
    const out = await runSkill(sk, values, {
      viewer: api.viewer,
      pluginTools: api.pluginTools,
      pluginTool: api.pluginTool,
      aborted: () => abortRef.current,
      locale,
      onStep: (i) => setRunning({ id: sk.id, step: i, total: sk.steps.length }),
      ask: (spec) =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
          setPending({ kind: "ask", spec, text: initialText(spec) });
        }),
      confirm: (message) =>
        new Promise((resolve) => {
          resolveRef.current = (v) => resolve(v === true);
          setPending({ kind: "confirm", message });
        }),
    });
    setPending(null);
    resolveRef.current = null;
    setRunning(null);
    if (out.inverses.length) setLastRun(out.inverses);
    if (out.status === "done") setMsg({ kind: "ok", text: t("assistant.skill.done", { n: out.executed }) });
    else if (out.status === "declined") setMsg({ kind: "err", text: t("assistant.skill.declined", { n: out.executed }) });
    else if (out.status === "aborted") setMsg({ kind: "err", text: t("assistant.skill.aborted", { n: out.executed }) });
    else setMsg({ kind: "err", text: t("assistant.skill.failed", { step: out.failedAt === undefined ? "-" : out.failedAt + 1, error: out.error ?? "?" }) });
  };

  const submitForm = () => {
    if (!form) return;
    const values: Record<string, unknown> = {};
    for (const spec of upFrontInputs(form.entry.skill)) {
      const c = parseFieldText(spec, form.text[spec.key] ?? "");
      if (!c.ok) return setMsg({ kind: "err", text: t("assistant.skill.badInput", { name: pick(spec.label, locale) }) });
      values[spec.key] = c.value;
    }
    void start(form.entry, values);
  };

  const answerAsk = () => {
    if (pending?.kind !== "ask") return;
    const c = parseFieldText(pending.spec, pending.text);
    if (!c.ok) return setMsg({ kind: "err", text: t("assistant.skill.badInput", { name: pick(pending.spec.label, locale) }) });
    setMsg(null);
    const r = resolveRef.current;
    setPending(null);
    r?.(c.value);
  };

  const abort = () => {
    abortRef.current = true;
    const r = resolveRef.current;
    resolveRef.current = null;
    setPending(null);
    r?.(null); // 待っている ask は取り消し、confirm は「やめる」として扱われる
  };

  const undo = async () => {
    if (!lastRun) return;
    const r = await undoRun(lastRun, api.viewer);
    if (!r.ok) return setMsg({ kind: "err", text: t("assistant.skill.undoFailed", { error: r.error }) });
    setLastRun(null);
    setMsg({ kind: "ok", text: r.skipped ? t("assistant.skill.undoneSome", { n: r.skipped }) : t("assistant.skill.undone") });
  };

  const remove = async (s: Skill) => {
    const r = await api.remove(s.id);
    if (!r.ok) setMsg({ kind: "err", text: t("assistant.skill.saveFailed", { error: r.error ?? "?" }) });
    await reload();
    onChanged?.();
  };

  const exportOne = (s: Skill) => {
    const url = URL.createObjectURL(new Blob([exportSkill(s)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `skill-${s.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setMsg(null);
    const chk = parseSkillText(await file.text(), api.pluginTools);
    if (!chk.ok) return setMsg({ kind: "err", text: t("assistant.skill.importFailed", { error: chk.error }) });
    if (BUNDLED_SKILLS.some((b) => b.id === chk.skill.id)) return setMsg({ kind: "err", text: t("assistant.skill.importFailed", { error: "id-reserved" }) });
    const r = await api.save(chk.skill);
    if (!r.ok) return setMsg({ kind: "err", text: t("assistant.skill.importFailed", { error: r.error ?? "?" }) });
    setMsg({ kind: "ok", text: t("assistant.skill.imported", { name: pick(chk.skill.title, locale) }) });
    await reload();
    onChanged?.();
  };

  const idle = running === null;
  return (
    <div style={P.root} data-testid="assistant-skill-panel">
      <div style={P.row}>
        <strong>{t("assistant.skill.title")}</strong>
        <label style={{ ...P.btn, marginLeft: "auto" }}>
          {t("assistant.skill.import")}
          <input type="file" accept=".json,application/json" style={{ display: "none" }} disabled={!idle} data-testid="assistant-skill-import" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      </div>
      {entries.map(({ skill, source }) => {
        const effect = skillEffect(skill, api.pluginTools);
        return (
          <div key={skill.id} style={P.item} data-testid="assistant-skill-item" data-skill-id={skill.id}>
            <div style={{ flex: "1 1 100%" }}>
              <span data-testid="assistant-skill-name">{pick(skill.title, locale)}</span>{" "}
              <span style={P.badge}>{t(`assistant.skill.source.${source}`)}</span>
              {effect === "write" && <span style={P.badgeWarn} data-testid="assistant-skill-write">{t("assistant.skill.write")}</span>}{" "}
              <span style={P.dim}>{t("assistant.skill.counts", { steps: skill.steps.length, inputs: skill.inputs.length })}</span>
              <div style={P.dim}>{pick(skill.description, locale)}</div>
              {open === skill.id && (
                <ol style={P.steps} data-testid="assistant-skill-steps">
                  {skill.steps.map((s, i) => (
                    <li key={i}>{stepSummary(t, s, skill, locale, api.pluginTools)}</li>
                  ))}
                </ol>
              )}
            </div>
            <button style={P.btn} onClick={() => setOpen(open === skill.id ? null : skill.id)} data-testid="assistant-skill-detail">{t("assistant.skill.detail")}</button>
            {running?.id === skill.id ? (
              <button style={P.btn} onClick={abort} data-testid="assistant-skill-abort">{t("assistant.skill.abort")}</button>
            ) : (
              <button style={P.btnPrimary} disabled={busy || !idle || form !== null} onClick={() => begin({ skill, source })} data-testid="assistant-skill-run">{t("assistant.skill.run")}</button>
            )}
            <button style={P.btn} disabled={!idle} onClick={() => exportOne(skill)} data-testid="assistant-skill-export">{t("assistant.skill.export")}</button>
            {source === "user" && (
              <button style={P.btn} disabled={!idle} onClick={() => void remove(skill)} data-testid="assistant-skill-delete">{t("assistant.skill.delete")}</button>
            )}
          </div>
        );
      })}
      {form && (
        <div style={P.card} data-testid="assistant-skill-form">
          {form.suggested && <span style={P.badge} data-testid="assistant-skill-suggested">{t("assistant.skill.suggested")}</span>}
          <strong>{pick(form.entry.skill.title, locale)}</strong>
          {form.suggested && (
            <>
              <ol style={P.steps} data-testid="assistant-skill-form-steps">
                {form.entry.skill.steps.map((s, i) => (
                  <li key={i}>{stepSummary(t, s, form.entry.skill, locale, api.pluginTools)}</li>
                ))}
              </ol>
              {skillEffect(form.entry.skill, api.pluginTools) === "write" && <span style={P.badgeWarn}>{t("assistant.skill.write")}</span>}
            </>
          )}
          {upFrontInputs(form.entry.skill).map((spec) => (
            <label key={spec.key} style={P.row}>
              <span style={{ minWidth: 120 }}>{pick(spec.label, locale)}</span>
              {spec.type === "enum" ? (
                <select value={form.text[spec.key] ?? ""} onChange={(e) => setForm({ ...form, text: { ...form.text, [spec.key]: e.target.value } })} style={P.input} data-testid={`assistant-skill-field-${spec.key}`}>
                  <option value="" />
                  {spec.values.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              ) : (
                <input style={P.input} value={form.text[spec.key] ?? ""} onChange={(e) => setForm({ ...form, text: { ...form.text, [spec.key]: e.target.value } })} data-testid={`assistant-skill-field-${spec.key}`} />
              )}
            </label>
          ))}
          <div style={P.row}>
            <button style={P.btnPrimary} onClick={submitForm} data-testid="assistant-skill-start">{t("assistant.skill.start")}</button>
            <button style={P.btn} onClick={() => setForm(null)} data-testid="assistant-skill-form-cancel">{t("assistant.skill.cancel")}</button>
          </div>
        </div>
      )}
      {draftSkill && (
        <div style={P.card} data-testid="assistant-skill-draft">
          <span style={P.badge}>{t("assistant.skill.draft")}</span>
          <strong data-testid="assistant-skill-draft-name">{pick(draftSkill.title, locale)}</strong>
          <div style={P.dim}>{pick(draftSkill.description, locale)}</div>
          <ol style={P.steps}>
            {draftSkill.steps.map((s, i) => (
              <li key={i}>{stepSummary(t, s, draftSkill, locale, api.pluginTools)}</li>
            ))}
          </ol>
          {skillEffect(draftSkill, api.pluginTools) === "write" && <span style={P.badgeWarn}>{t("assistant.skill.write")}</span>}
          <div style={P.row}>
            <button style={P.btnPrimary} onClick={() => void saveDraft()} data-testid="assistant-skill-draft-save">{t("assistant.skill.save")}</button>
            <button style={P.btn} onClick={() => setDraftSkill(null)} data-testid="assistant-skill-draft-discard">{t("assistant.skill.discard")}</button>
          </div>
        </div>
      )}
      {running && (
        <div style={P.dim} data-testid="assistant-skill-progress">{t("assistant.skill.progress", { n: running.step + 1, total: running.total })}</div>
      )}
      {pending?.kind === "ask" && (
        <div style={P.card} data-testid="assistant-skill-ask">
          <span>{pick(pending.spec.label, locale)}</span>
          <div style={P.row}>
            <input
              style={P.input}
              autoFocus
              value={pending.text}
              onChange={(e) => setPending({ ...pending, text: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") answerAsk(); }}
              data-testid="assistant-skill-ask-input"
            />
            <button style={P.btnPrimary} onClick={answerAsk} data-testid="assistant-skill-ask-ok">{t("assistant.skill.ok")}</button>
          </div>
        </div>
      )}
      {pending?.kind === "confirm" && (
        <div style={P.card} data-testid="assistant-skill-confirm">
          <span data-testid="assistant-skill-confirm-message">{pending.message}</span>
          <div style={P.row}>
            <button style={P.btn} autoFocus onClick={() => { const r = resolveRef.current; setPending(null); r?.(false); }} data-testid="assistant-skill-confirm-no">{t("assistant.skill.stop")}</button>
            <button style={P.btnPrimary} onClick={() => { const r = resolveRef.current; setPending(null); r?.(true); }} data-testid="assistant-skill-confirm-yes">{t("assistant.skill.continue")}</button>
          </div>
        </div>
      )}
      {lastRun && idle && (
        <button style={P.btn} onClick={() => void undo()} data-testid="assistant-skill-undo">{t("assistant.skill.undoAll")}</button>
      )}
      {msg && <div style={msg.kind === "err" ? P.err : P.ok} data-testid="assistant-skill-msg">{msg.text}</div>}
    </div>
  );
}

const P: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", borderTop: "1px solid #3a3b3f", background: "#26272b", fontSize: 12, maxHeight: "45vh", overflowY: "auto" },
  item: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "4px 6px", border: "1px solid #3a3b3f", borderRadius: 6 },
  card: { display: "flex", flexDirection: "column", gap: 6, padding: "6px 8px", border: "1px solid #2f5fa8", borderRadius: 6 },
  row: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  dim: { color: "#9aa0a6", overflowWrap: "anywhere" },
  steps: { margin: "4px 0 0 16px", padding: 0, color: "#9aa0a6" },
  badge: { padding: "0 6px", borderRadius: 8, border: "1px solid #5f6368", color: "#9aa0a6" },
  badgeWarn: { padding: "0 6px", borderRadius: 8, border: "1px solid #f9ab00", color: "#f9ab00", marginLeft: 4 },
  input: { flex: 1, minWidth: 120, padding: "4px 6px", borderRadius: 6, border: "1px solid #5f6368", background: "transparent", color: "inherit" },
  btn: { padding: "3px 8px", borderRadius: 6, border: "1px solid #5f6368", background: "transparent", color: "inherit", cursor: "pointer" },
  btnPrimary: { padding: "3px 8px", borderRadius: 6, border: "none", background: "#2f5fa8", color: "#fff", cursor: "pointer" },
  err: { color: "#f28b82", overflowWrap: "anywhere" },
  ok: { color: "#81c995" },
};
