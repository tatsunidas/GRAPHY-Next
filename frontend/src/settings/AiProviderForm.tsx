/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 提供元 1 件の追加・編集フォーム。設計: `fw/ai-routing-design.md` §14
 *
 * <h3>🔑 何のためにあるか</h3>
 * **「どの AI が来ても足せる」ようにするため。** OpenAI 互換の口を持つ提供元なら、
 * アダプタを書かずにここから登録できる。
 *
 * <h3>🔴 検査をここに書き写さないこと</h3>
 * 形の検査は main の `aiProviders.validateProvider` が正本。ここは入力中に
 * `aiProvidersValidate`（書かない口）を叩いて**その結果を見せるだけ**。
 * 二重に持つと必ずずれ、「画面では通るのに保存で消える」が起きる。
 *
 * <h3>意図的に出していない欄</h3>
 * **追加ヘッダ（`headers`）**。自由記入欄を出すと利用者は必ず `x-api-key: sk-…` を貼り、
 * 鍵が `ai-providers.json` に平文で入る（そこはレンダラから読める）。JSON を手で書く人のために
 * 受理はするが、欄は出さない。
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { desktop, type AiProviderEntry } from "../desktopBridge";

/** 編集中の下書き。**すべて文字列で持つ**（入力途中の状態を壊さない）。 */
export interface ProviderDraft {
  id: string;
  label: string;
  kind: string;
  endpoint: string;
  pathStyle: string;
  apiVersion: string;
  authHeader: string;
  authPrefix: string;
  models: Record<string, string>;
  paths: Record<string, string>;
}

/** 既定値の案内（placeholder に出す）。**空欄＝この既定を使う**が見て分かるように。 */
const DEFAULTS: Record<string, { auth: string; prefix: string; apiVersion: string; path: Record<string, string> }> = {
  gemini: {
    auth: "x-goog-api-key",
    prefix: "",
    apiVersion: "v1beta",
    path: { "image-to-image": "/v1beta/models/<model>:generateContent", "image-to-text": "/v1beta/models/<model>:generateContent" },
  },
  openai: {
    auth: "Authorization",
    prefix: "Bearer ",
    apiVersion: "",
    path: { "image-to-image": "/v1/images/edits", "image-to-text": "/v1/chat/completions" },
  },
  "azure-openai": {
    auth: "api-key",
    prefix: "",
    apiVersion: "2024-10-21",
    path: { "image-to-image": "/openai/deployments/<model>/images/edits", "image-to-text": "/openai/deployments/<model>/chat/completions" },
  },
};

export function emptyDraft(capabilities: string[]): ProviderDraft {
  const models: Record<string, string> = {};
  const paths: Record<string, string> = {};
  for (const c of capabilities) {
    models[c] = "";
    paths[c] = "";
  }
  return { id: "", label: "", kind: "openai", endpoint: "", pathStyle: "", apiVersion: "", authHeader: "", authPrefix: "", models, paths };
}

export function toDraft(p: AiProviderEntry, capabilities: string[]): ProviderDraft {
  const d = emptyDraft(capabilities);
  const auth = typeof p.auth === "object" && p.auth ? p.auth : {};
  return {
    ...d,
    id: p.id,
    label: p.label,
    kind: p.kind,
    endpoint: p.endpoint,
    pathStyle: p.pathStyle ?? "",
    apiVersion: p.apiVersion ?? "",
    authHeader: auth.header ?? "",
    authPrefix: auth.prefix ?? "",
    models: { ...d.models, ...p.models },
    paths: { ...d.paths, ...(p.paths ?? {}) },
  };
}

/** 下書きを保存する形へ。**空欄は項目ごと落とす**（「未指定＝既定」を保つ）。 */
export function fromDraft(d: ProviderDraft): AiProviderEntry {
  const models: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.models)) if (v.trim()) models[k] = v.trim();
  const paths: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.paths)) if (v.trim()) paths[k] = v.trim();
  const out: AiProviderEntry = {
    id: d.id.trim(),
    label: d.label.trim() || d.id.trim(),
    kind: d.kind,
    endpoint: d.endpoint.trim(),
    models,
  };
  if (d.authHeader.trim() || d.authPrefix) out.auth = { header: d.authHeader.trim(), prefix: d.authPrefix };
  if (d.pathStyle) out.pathStyle = d.pathStyle;
  if (d.apiVersion.trim()) out.apiVersion = d.apiVersion.trim();
  if (Object.keys(paths).length) out.paths = paths;
  return out;
}

interface Props {
  draft: ProviderDraft;
  /** 新規なら true（id を編集できるのは新規のときだけ）。 */
  isNew: boolean;
  capabilities: string[];
  /** ほかの提供元（保存時に丸ごと渡すため、検査もこの並びで行う）。 */
  others: AiProviderEntry[];
  defaults: Record<string, string>;
  busy: boolean;
  onCancel: () => void;
  onSave: (entry: AiProviderEntry) => void;
}

export function AiProviderForm({ draft: initial, isNew, capabilities, others, defaults, busy, onCancel, onSave }: Props) {
  const { t } = useI18n();
  const d = desktop();
  const [draft, setDraft] = useState<ProviderDraft>(initial);
  const [problems, setProblems] = useState<string[]>([]);

  const entry = useMemo(() => fromDraft(draft), [draft]);
  const hint = DEFAULTS[draft.kind] ?? DEFAULTS.openai;

  // 🔑 入力中の検査は **main に聞く**（規則を書き写さない）。300ms だけ待つ。
  useEffect(() => {
    const validate = d?.aiProvidersValidate;
    if (!validate) return;
    let alive = true;
    const timer = setTimeout(() => {
      void validate({ providers: [...others, entry], defaults })
        .then((r) => {
          if (!alive) return;
          // この提供元に関わるものだけを見せる（他の提供元の問題は下部にまとめて出る）。
          setProblems(r.problems.filter((p) => p.startsWith(`provider:${entry.id}:`) || p.startsWith("config:")));
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [d, entry, others, defaults]);

  const set = (patch: Partial<ProviderDraft>) => setDraft((s) => ({ ...s, ...patch }));
  const idOk = /^[a-z0-9-]{1,32}$/.test(draft.id.trim());
  const usable = Object.values(draft.models).some((m) => m.trim());
  const canSave = idOk && usable && draft.endpoint.trim().length > 0 && problems.length === 0;

  return (
    <div style={form} data-testid="ai-provider-form">
      <Field label={t("settings.ai.provider.id")}>
        {isNew ? (
          <input
            style={input}
            value={draft.id}
            onChange={(e) => set({ id: e.target.value })}
            placeholder="grok"
            spellCheck={false}
            data-testid="ai-provider-field-id"
          />
        ) : (
          <>
            <span style={mono} data-testid="ai-provider-field-id">{draft.id}</span>
            {/* 🔴 id を変えられるようにしない。鍵の名前に入っているので、変えると鍵が
                消えたように見える（削除して作り直す＝鍵も入れ直す、が正しい）。 */}
            <span style={helpInline}>{t("settings.ai.provider.id.immutable")}</span>
          </>
        )}
      </Field>
      {isNew && draft.id && !idOk ? <p style={err}>{t("settings.ai.problem.invalid-id")}</p> : null}

      <Field label={t("settings.ai.provider.label")}>
        <input style={input} value={draft.label} onChange={(e) => set({ label: e.target.value })}
               placeholder={draft.id || "xAI Grok"} data-testid="ai-provider-field-label" />
      </Field>

      <Field label={t("settings.ai.provider.kind")}>
        <select style={{ ...input, maxWidth: 200 }} value={draft.kind}
                onChange={(e) => set({ kind: e.target.value })} data-testid="ai-provider-field-kind">
          <option value="openai">{t("settings.ai.provider.kind.openai")}</option>
          <option value="gemini">{t("settings.ai.provider.kind.gemini")}</option>
          <option value="azure-openai">{t("settings.ai.provider.kind.azure")}</option>
        </select>
      </Field>

      <Field label={t("settings.ai.provider.endpoint")}>
        <input style={input} value={draft.endpoint} onChange={(e) => set({ endpoint: e.target.value })}
               placeholder="https://api.x.ai" spellCheck={false} data-testid="ai-provider-field-endpoint" />
      </Field>
      <p style={helpBlock}>{t("settings.ai.provider.endpoint.help")}</p>

      {capabilities.map((cap) => (
        <Field key={cap} label={t(`settings.ai.cap.${cap}`)}>
          <input
            style={input}
            value={draft.models[cap] ?? ""}
            onChange={(e) => set({ models: { ...draft.models, [cap]: e.target.value } })}
            placeholder={t("settings.ai.provider.models.unused")}
            spellCheck={false}
            data-testid={`ai-provider-field-model-${cap}`}
          />
        </Field>
      ))}
      <p style={helpBlock}>{t("settings.ai.provider.models.help")}</p>

      <details style={{ margin: "6px 0" }}>
        <summary style={{ fontSize: 12, cursor: "pointer" }} data-testid="ai-provider-advanced">
          {t("settings.ai.provider.advanced")}
        </summary>
        <div style={{ paddingTop: 6 }}>
          <Field label={t("settings.ai.provider.auth.header")}>
            <input style={input} value={draft.authHeader} onChange={(e) => set({ authHeader: e.target.value })}
                   placeholder={hint.auth} spellCheck={false} data-testid="ai-provider-field-auth-header" />
          </Field>
          <Field label={t("settings.ai.provider.auth.prefix")}>
            <input style={input} value={draft.authPrefix} onChange={(e) => set({ authPrefix: e.target.value })}
                   placeholder={hint.prefix || t("settings.ai.provider.auth.noPrefix")}
                   spellCheck={false} data-testid="ai-provider-field-auth-prefix" />
          </Field>
          <Field label={t("settings.ai.provider.pathStyle")}>
            <select style={{ ...input, maxWidth: 240 }} value={draft.pathStyle}
                    onChange={(e) => set({ pathStyle: e.target.value })} data-testid="ai-provider-field-pathstyle">
              <option value="">{t("settings.ai.provider.pathStyle.default")}</option>
              <option value="openai">{t("settings.ai.provider.pathStyle.openai")}</option>
              <option value="azure-deployment">{t("settings.ai.provider.pathStyle.azure")}</option>
            </select>
          </Field>
          <Field label={t("settings.ai.provider.apiVersion")}>
            <input style={input} value={draft.apiVersion} onChange={(e) => set({ apiVersion: e.target.value })}
                   placeholder={hint.apiVersion || t("settings.ai.provider.apiVersion.unused")}
                   spellCheck={false} data-testid="ai-provider-field-apiversion" />
          </Field>
          {capabilities.map((cap) => (
            <Field key={cap} label={t("settings.ai.provider.path", { cap: t(`settings.ai.cap.${cap}`) })}>
              <input
                style={input}
                value={draft.paths[cap] ?? ""}
                onChange={(e) => set({ paths: { ...draft.paths, [cap]: e.target.value } })}
                placeholder={hint.path[cap] ?? ""}
                spellCheck={false}
                data-testid={`ai-provider-field-path-${cap}`}
              />
            </Field>
          ))}
          <p style={helpBlock}>{t("settings.ai.provider.advanced.help")}</p>
        </div>
      </details>

      {problems.length > 0 ? (
        <ul style={errList} data-testid="ai-provider-form-error">
          {problems.map((p) => (
            <li key={p}>{describeProblem(p, t)}</li>
          ))}
        </ul>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button style={primary} disabled={busy || !canSave} onClick={() => onSave(entry)} data-testid="ai-provider-form-save">
          {t("common.save")}
        </button>
        <button style={btn} disabled={busy} onClick={onCancel} data-testid="ai-provider-form-cancel">
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * `provider:<id>:<code>` を人の言葉にする。
 *
 * <p>🔑 コードは main が返す機械可読な値。**訳が無いものは生のまま出す**——
 * 新しい検査を足したときに「何も出ない」より「読めないが手がかりはある」ほうがよい。
 */
export function describeProblem(problem: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const body = problem.replace(/^provider:[^:]*:/, "").replace(/^config:/, "");
  const code = body.split(":")[0];
  const arg = body.slice(code.length + 1);
  const key = `settings.ai.problem.${code}`;
  const translated = t(key, { arg });
  return translated === key ? problem : translated;
}

function Field({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={row}>
      <span style={label}>{text}</span>
      {children}
    </div>
  );
}

const form: React.CSSProperties = {
  border: "1px solid #b7c7d8",
  borderRadius: 4,
  padding: "8px 10px",
  margin: "6px 0",
  background: "#f4f8fc",
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "3px 0", flexWrap: "wrap" };
const label: React.CSSProperties = { width: 140, fontSize: 12, color: "#42505f" };
const input: React.CSSProperties = {
  flex: "1 1 220px", minWidth: 160, maxWidth: 420, padding: "3px 6px",
  border: "1px solid #cdd5de", borderRadius: 3, fontSize: 12,
};
const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 11, color: "#42505f" };
const helpInline: React.CSSProperties = { fontSize: 11, color: "#6b7785" };
const helpBlock: React.CSSProperties = { fontSize: 11, color: "#6b7785", margin: "2px 0 8px 148px" };
const err: React.CSSProperties = { fontSize: 11, color: "#b00020", margin: "0 0 4px 148px" };
const errList: React.CSSProperties = { fontSize: 11, color: "#b00020", margin: "6px 0 0 148px", paddingLeft: 16 };
const btn: React.CSSProperties = {
  padding: "3px 10px", border: "1px solid #cdd5de", borderRadius: 3, background: "#fff", fontSize: 12, cursor: "pointer",
};
const primary: React.CSSProperties = { ...btn, background: "#0b5cad", color: "#fff", borderColor: "#0b5cad" };
