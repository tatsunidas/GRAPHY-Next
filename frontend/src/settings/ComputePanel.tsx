/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 外部の計算機（Jupyter Server）。設計: `fw/remote-compute-design.md`
 *
 * <h3>何を登録するか</h3>
 * GPU のある計算機の Jupyter Server（院内の GPU 機・契約したクラウド）。プラグインはここへ
 * 匿名化した画像とコードを送って計算させる（段 5 以降）。Colab は Google の許可が下りてから足す。
 *
 * <h3>この画面が持たないもの</h3>
 * - **検査規則**: main の `computeEndpoints.validate` に 1 つだけ（書き写すと必ずずれる）
 * - **送信先を足す判断**: 保存すると main が確認ダイアログを出す（プラグインからは迂回できない）
 * - **トークンの値**: OS のキーチェーンに預け、読み出す経路は無い（有無だけ）
 */
import React, { useCallback, useEffect, useState } from "react";
import { useI18n, type TFn } from "../i18n/i18n";
import {
  desktop,
  type ColabSpecsResult,
  type ColabStatus,
  type ComputeEndpointEntry,
  type ComputeEndpointInput,
  type ComputeEndpointsConfig,
  type ComputeTestResult,
} from "../desktopBridge";

const EMPTY: ComputeEndpointInput = { id: "", label: "", url: "" };

export function ComputePanel() {
  const { t } = useI18n();
  const d = desktop();
  const [config, setConfig] = useState<ComputeEndpointsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 接続先 id → 入力中のトークン。保存したら消す（画面に残さない）。 */
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, ComputeTestResult | "running">>({});
  const [editing, setEditing] = useState<{ draft: ComputeEndpointInput; isNew: boolean; problems: string[] } | null>(
    null,
  );
  const [colab, setColab] = useState<ColabStatus | null>(null);
  const [colabSpecs, setColabSpecs] = useState<ColabSpecsResult | null>(null);
  /** 追加しようとしている Colab のランタイムの種類（"VARIANT/ACCELERATOR/SHAPE"）。 */
  const [colabPick, setColabPick] = useState("");

  const refresh = useCallback(async () => {
    if (!d?.computeEndpointsGet) return;
    try {
      setConfig(await d.computeEndpointsGet());
      if (d.computeColabStatus) {
        const st = await d.computeColabStatus();
        setColab(st);
        if (st.signedIn && d.computeColabSpecs) setColabSpecs(await d.computeColabSpecs());
      }
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  }, [d, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!d?.computeEndpointsGet || !d.secretSet) {
    return <p style={notice} data-testid="compute-desktop-only">{t("settings.compute.desktopOnly")}</p>;
  }

  const endpoints = config?.endpoints ?? [];
  const asInput = (e: ComputeEndpointEntry): ComputeEndpointInput =>
    e.kind === "colab"
      ? { id: e.id, label: e.label, kind: "colab", spec: e.spec }
      : { id: e.id, label: e.label, kind: "jupyter", url: e.url };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
      d.refocus?.();
    }
  };

  /** 一覧を丸ごと保存する。送信先が変わるなら main が確認を出す。 */
  const saveList = async (list: ComputeEndpointInput[]): Promise<boolean> => {
    const r = await d.computeEndpointsSet!({ endpoints: list });
    if (r.canceled) {
      setMessage(t("settings.compute.canceled"));
      return false;
    }
    if (!r.ok) {
      setError(r.problems.map((p) => describeProblem(t, p)).join(" / "));
      return false;
    }
    await refresh();
    return true;
  };

  const submitEdit = () =>
    run(async () => {
      if (!editing) return;
      const others = endpoints.filter((e) => e.id !== editing.draft.id).map(asInput);
      const list = editing.isNew
        ? [...endpoints.map(asInput), editing.draft]
        : endpoints.map((e) => (e.id === editing.draft.id ? editing.draft : asInput(e)));
      if (editing.isNew && others.length !== endpoints.length) {
        setEditing({ ...editing, problems: [`${editing.draft.id}:duplicate-id`] });
        return;
      }
      const checked = await d.computeEndpointsValidate!({ endpoints: list });
      if (!checked.ok) {
        setEditing({ ...editing, problems: checked.problems });
        return;
      }
      if (await saveList(list)) {
        setEditing(null);
        setMessage(t("settings.compute.saved"));
      }
    });

  const remove = (e: ComputeEndpointEntry) =>
    run(async () => {
      if (!window.confirm(t("settings.compute.deleteConfirm", { label: e.label }))) return;
      // 消した接続先のトークンは main が一緒に消す
      if (await saveList(endpoints.filter((x) => x.id !== e.id).map(asInput))) {
        setMessage(t("settings.compute.deleted", { label: e.label }));
      }
    });

  const saveToken = (e: ComputeEndpointEntry) =>
    run(async () => {
      const value = (tokens[e.id] ?? "").trim();
      if (!value) return;
      if (!e.secretKey) return;
      const r = await d.secretSet!(e.secretKey, value);
      if (!r.ok) {
        setError(t(`settings.ai.err.${r.reason ?? "unknown"}`));
        return;
      }
      setTokens((s) => ({ ...s, [e.id]: "" }));
      // 永続化できなかったら必ず言う（次の起動で消えるので）
      setMessage(r.persisted ? t("settings.compute.tokenSaved") : t("settings.ai.savedSessionOnly"));
      await refresh();
    });

  const clearToken = (e: ComputeEndpointEntry) =>
    run(async () => {
      if (!e.secretKey || !window.confirm(t("settings.compute.token.clearConfirm"))) return;
      await d.secretClear!(e.secretKey);
      setMessage(t("settings.compute.tokenCleared"));
      await refresh();
    });

  // ── Colab ──
  const colabSignIn = () =>
    run(async () => {
      setMessage(t("settings.compute.colab.signingIn"));
      const r = await d.computeColabSignIn!();
      if (!r.ok) setError(t("settings.compute.colab.err", { error: r.error ?? "" }));
      else setMessage(t("settings.compute.colab.signedInAs", { email: r.email ?? "" }));
      await refresh();
    });

  const colabSignOut = () =>
    run(async () => {
      if (!window.confirm(t("settings.compute.colab.signOutConfirm"))) return;
      await d.computeColabSignOut!();
      setColabSpecs(null);
      setMessage(t("settings.compute.colab.signedOut"));
      await refresh();
    });

  /** 選んだ種類の Colab の計算機を足す。送り先（Google の Colab）が増えるので main が確認を出す。 */
  const colabAdd = () =>
    run(async () => {
      const [variant, accelerator, shape] = colabPick.split("/");
      if (!variant) return;
      const id = `colab-${accelerator.toLowerCase()}${shape === "SHAPE_HIGHMEM" ? "-highmem" : ""}`.replace(/_/g, "-");
      const list = [...endpoints.filter((e) => e.id !== id).map(asInput),
        { id, label: `Colab ${specLabel(t, { variant, accelerator, shape })}`, kind: "colab" as const, spec: { variant, accelerator, shape } }];
      if (await saveList(list)) setMessage(t("settings.compute.saved"));
    });

  const colabEnsure = (e: ComputeEndpointEntry) =>
    run(async () => {
      setMessage(t("settings.compute.colab.allocating"));
      const r = await d.computeColabEnsure!(e.id);
      if (!r.ok) setError(t(`settings.compute.colab.err.${r.error}`) === `settings.compute.colab.err.${r.error}`
        ? t("settings.compute.colab.err", { error: r.error ?? "" })
        : t(`settings.compute.colab.err.${r.error}`));
      else setMessage(t("settings.compute.colab.allocated"));
      await refresh();
    });

  const colabRelease = (e: ComputeEndpointEntry) =>
    run(async () => {
      await d.computeColabRelease!(e.id);
      setMessage(t("settings.compute.colab.released"));
      await refresh();
    });

  const runTest = async (e: ComputeEndpointEntry) => {
    if (!d.computeTestConnection) return;
    setTests((s) => ({ ...s, [e.id]: "running" }));
    try {
      const r = await d.computeTestConnection(e.id);
      setTests((s) => ({ ...s, [e.id]: r }));
    } catch (err) {
      setTests((s) => ({ ...s, [e.id]: { ok: false, stage: "bridge", error: String(err) } }));
    }
  };

  return (
    <div data-testid="compute-panel">
      <p style={help}>{t("settings.compute.intro")}</p>
      {config && !config.available ? (
        <p style={warn} data-testid="compute-unavailable">{t("settings.compute.unavailable")}</p>
      ) : null}
      {config && config.problems.length > 0 ? (
        <ul style={noticeList}>
          {config.problems.map((p) => (
            <li key={p}>{describeProblem(t, p)}</li>
          ))}
        </ul>
      ) : null}

      {colab ? (
        <section style={{ marginBottom: 22 }} data-testid="compute-colab">
          <h3 style={sectionTitle}>{t("settings.compute.colab.title")}</h3>
          {!colab.configured ? (
            <p style={notice}>{t("settings.compute.colab.notConfigured")}</p>
          ) : !colab.signedIn ? (
            <div style={row}>
              <button style={smallBtn} disabled={busy} onClick={() => void colabSignIn()} data-testid="compute-colab-signin">
                {t("settings.compute.colab.signIn")}
              </button>
              <span style={{ fontSize: 11, color: "#6b7785" }}>{t("settings.compute.colab.signIn.help")}</span>
            </div>
          ) : (
            <>
              <div style={row}>
                <span style={{ fontSize: 12 }} data-testid="compute-colab-account">
                  {t("settings.compute.colab.account", {
                    email: colab.email ?? "?",
                    tier: colabSpecs && colabSpecs.ok ? tierLabel(t, colabSpecs.tier) : "…",
                  })}
                </span>
                <span style={{ flex: 1 }} />
                <button style={smallBtn} disabled={busy} onClick={() => void colabSignOut()} data-testid="compute-colab-signout">
                  {t("settings.compute.colab.signOut")}
                </button>
              </div>
              {colabSpecs && colabSpecs.ok ? (
                <div style={row}>
                  <select
                    style={{ ...input, maxWidth: 280 }}
                    value={colabPick}
                    onChange={(ev) => setColabPick(ev.target.value)}
                    data-testid="compute-colab-spec"
                  >
                    <option value="">{t("settings.compute.colab.pick")}</option>
                    {colabSpecs.specs.map((s) => (
                      <option key={`${s.variant}/${s.accelerator}/${s.shape}`} value={`${s.variant}/${s.accelerator}/${s.shape}`} disabled={!s.eligible}>
                        {specLabel(t, s) + (s.eligible ? "" : ` — ${t("settings.compute.colab.notEligible")}`)}
                      </option>
                    ))}
                  </select>
                  <button style={smallBtn} disabled={busy || !colabPick} onClick={() => void colabAdd()} data-testid="compute-colab-add">
                    {t("settings.compute.colab.add")}
                  </button>
                </div>
              ) : colabSpecs && !colabSpecs.ok ? (
                <p style={warn}>{t("settings.compute.colab.err", { error: colabSpecs.error })}</p>
              ) : null}
              <p style={help}>{t("settings.compute.colab.help")}</p>
            </>
          )}
        </section>
      ) : null}

      <section style={{ marginBottom: 22 }}>
        <h3 style={sectionTitle}>{t("settings.compute.sec.endpoints")}</h3>
        {endpoints.length === 0 ? <p style={notice}>{t("settings.compute.none")}</p> : null}
        {endpoints.map((e) => {
          const test = tests[e.id];
          return (
            <div key={e.id} style={box} data-testid={`compute-endpoint-${e.id}`}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <b style={{ fontSize: 12 }}>{e.label}</b>
                <span style={mono}>{e.kind === "colab" ? "Google Colab" : e.url}</span>
                {e.plaintext ? (
                  <span style={warnBadge} title={t("settings.compute.plaintext.help")}>
                    {t("settings.ai.plaintext")}
                  </span>
                ) : null}
                <span style={{ flex: 1 }} />
                {e.kind !== "colab" ? (
                  <button
                    style={smallBtn}
                    disabled={busy}
                    onClick={() => setEditing({ draft: asInput(e), isNew: false, problems: [] })}
                    data-testid={`compute-edit-${e.id}`}
                  >
                    {t("settings.ai.provider.edit")}
                  </button>
                ) : null}
                <button
                  style={{ ...smallBtn, color: "#b00020" }}
                  disabled={busy}
                  title={t("common.delete")}
                  onClick={() => void remove(e)}
                  data-testid={`compute-delete-${e.id}`}
                >
                  ✕
                </button>
              </div>

              {e.kind === "colab" ? (
                <div style={row} data-testid={`compute-colab-runtime-${e.id}`}>
                  <span style={label}>{t("settings.compute.colab.runtime")}</span>
                  <span style={{ fontSize: 11, color: e.runtime?.allocated ? "#1b7a3a" : "#6b7785" }}>
                    {e.runtime?.allocated
                      ? t("settings.compute.colab.runtime.on", { until: new Date(e.runtime.expireTime ?? "").toLocaleTimeString() })
                      : t("settings.compute.colab.runtime.off")}
                  </span>
                  {e.runtime?.allocated ? (
                    <button style={smallBtn} disabled={busy} onClick={() => void colabRelease(e)} data-testid={`compute-colab-release-${e.id}`}>
                      {t("settings.compute.colab.release")}
                    </button>
                  ) : (
                    <button style={smallBtn} disabled={busy || !e.hasToken} onClick={() => void colabEnsure(e)} data-testid={`compute-colab-ensure-${e.id}`}>
                      {t("settings.compute.colab.ensure")}
                    </button>
                  )}
                </div>
              ) : (
              <div style={row}>
                <span style={label}>{t("settings.compute.token")}</span>
                <span style={{ fontSize: 11, color: e.hasToken ? "#1b7a3a" : "#8a4b00" }}>
                  {e.hasToken ? t("settings.compute.token.set") : t("settings.compute.token.unset")}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  style={{ ...input, maxWidth: 240 }}
                  placeholder={t("settings.compute.token.placeholder")}
                  value={tokens[e.id] ?? ""}
                  onChange={(ev) => setTokens((s) => ({ ...s, [e.id]: ev.target.value }))}
                  data-testid={`compute-token-${e.id}`}
                />
                <button
                  style={smallBtn}
                  disabled={busy || !(tokens[e.id] ?? "").trim()}
                  onClick={() => void saveToken(e)}
                >
                  {t("common.save")}
                </button>
                {e.hasToken ? (
                  <button style={smallBtn} disabled={busy} onClick={() => void clearToken(e)}>
                    {t("settings.compute.token.clear")}
                  </button>
                ) : null}
              </div>
              )}

              <div style={row}>
                <button
                  style={smallBtn}
                  disabled={busy || test === "running" || (e.kind === "colab" && !e.runtime?.allocated)}
                  onClick={() => void runTest(e)}
                  data-testid={`compute-test-${e.id}`}
                >
                  {test === "running" ? t("settings.compute.test.running") : t("settings.compute.test")}
                </button>
                <span style={{ fontSize: 11, color: "#6b7785" }}>{t("settings.compute.test.help")}</span>
              </div>
              {test && test !== "running" ? <TestResultView r={test} /> : null}
            </div>
          );
        })}

        {editing ? (
          <div style={box} data-testid="compute-form">
            <div style={row}>
              <span style={label}>{t("settings.compute.field.id")}</span>
              <input
                style={{ ...input, maxWidth: 200 }}
                value={editing.draft.id}
                disabled={!editing.isNew}
                placeholder="lab-gpu"
                onChange={(ev) => setEditing({ ...editing, draft: { ...editing.draft, id: ev.target.value.trim() } })}
                data-testid="compute-field-id"
              />
            </div>
            <div style={row}>
              <span style={label}>{t("settings.compute.field.label")}</span>
              <input
                style={{ ...input, maxWidth: 260 }}
                value={editing.draft.label}
                onChange={(ev) => setEditing({ ...editing, draft: { ...editing.draft, label: ev.target.value } })}
                data-testid="compute-field-label"
              />
            </div>
            <div style={row}>
              <span style={label}>{t("settings.compute.field.url")}</span>
              <input
                style={{ ...input, maxWidth: 360 }}
                value={editing.draft.url}
                placeholder="https://gpu.example.org/"
                onChange={(ev) => setEditing({ ...editing, draft: { ...editing.draft, url: ev.target.value.trim() } })}
                data-testid="compute-field-url"
              />
            </div>
            <p style={help}>{t("settings.compute.field.url.help")}</p>
            {editing.problems.length > 0 ? (
              <ul style={noticeList}>
                {editing.problems.map((p) => (
                  <li key={p}>{describeProblem(t, p)}</li>
                ))}
              </ul>
            ) : null}
            <div style={{ display: "flex", gap: 8 }}>
              <button style={smallBtn} disabled={busy} onClick={() => void submitEdit()} data-testid="compute-form-save">
                {t("common.save")}
              </button>
              <button style={smallBtn} disabled={busy} onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button
            style={addBtn}
            disabled={busy}
            onClick={() => setEditing({ draft: { ...EMPTY }, isNew: true, problems: [] })}
            data-testid="compute-add"
          >
            {t("settings.compute.add")}
          </button>
        )}
      </section>

      {message ? <p style={{ fontSize: 12, color: "#1b7a3a" }}>{message}</p> : null}
      {error ? <p style={{ fontSize: 12, color: "#b00020" }}>{error}</p> : null}
    </div>
  );
}

/** 接続テストの結果。落ちた段と、届いた計算機の中身（Python・GPU・PyTorch）を出す。 */
function TestResultView({ r }: { r: ComputeTestResult }) {
  const { t } = useI18n();
  if (!r.ok) {
    const auth = r.httpStatus === 401 || r.httpStatus === 403;
    return (
      <div style={{ ...resultBox, borderColor: "#e0b884" }} data-testid="compute-test-failed">
        <b style={{ color: "#8a4b00" }}>{t(`settings.compute.stage.${r.stage}`)}</b>
        {auth ? <span style={{ fontSize: 11 }}>{t("settings.compute.test.auth")}</span> : null}
        {r.error ? <pre style={pre}>{r.error}</pre> : null}
      </div>
    );
  }
  const p = r.probe ?? {};
  const gpus = p.gpus ?? [];
  return (
    <div style={resultBox} data-testid="compute-test-ok">
      <b style={{ color: "#1b7a3a" }}>{t("settings.compute.test.ok", { ms: String(r.elapsedMs ?? 0) })}</b>
      <span style={{ fontSize: 11 }}>
        {`Jupyter Server ${r.serverVersion ?? "?"} · Python ${p.python ?? "?"} · ${p.platform ?? ""}`}
      </span>
      <span style={{ fontSize: 11 }} data-testid="compute-test-gpus">
        {gpus.length > 0
          ? `GPU: ${gpus.map((g) => `${g.name}${g.memory ? ` (${g.memory})` : ""}`).join(", ")}`
          : t("settings.compute.test.noGpu")}
      </span>
      <span style={{ fontSize: 11 }}>
        {p.torch
          ? `PyTorch ${p.torch.version} · CUDA ${p.torch.cuda ? t("settings.compute.yes") : t("settings.compute.no")}`
          : t("settings.compute.test.noTorch")}
      </span>
    </div>
  );
}

/** Colab のランタイムの種類を読める名前に（例「GPU T4」「CPU（高メモリ）」）。 */
function specLabel(t: TFn, s: { variant: string; accelerator: string; shape: string }): string {
  const kind = s.variant.replace(/^VARIANT_/, "");
  const accel = s.accelerator === "NONE" ? "" : ` ${s.accelerator}`;
  return `${kind}${accel}${s.shape === "SHAPE_HIGHMEM" ? ` ${t("settings.compute.colab.highmem")}` : ""}`;
}

function tierLabel(t: TFn, tier: string | null): string {
  const key = `settings.compute.colab.tier.${tier ?? "unknown"}`;
  const s = t(key);
  return s === key ? (tier ?? "?") : s;
}

/** main の検査結果（`<id>:<理由>`）を読める文に。 */
function describeProblem(t: TFn, p: string): string {
  const i = p.lastIndexOf(":");
  if (p.startsWith("config:")) return t("settings.compute.err.config", { detail: p });
  if (i < 0) return p;
  const id = p.slice(0, i);
  const reason = p.slice(i + 1);
  const key = `settings.compute.err.${reason}`;
  const msg = t(key);
  return `${id}: ${msg === key ? reason : msg}`;
}

const sectionTitle: React.CSSProperties = { fontSize: 13, margin: "0 0 8px", color: "#334" };
const help: React.CSSProperties = { fontSize: 11, color: "#6b7785", margin: "4px 0 8px", lineHeight: 1.6 };
const notice: React.CSSProperties = { fontSize: 12, color: "#6b7785" };
const warn: React.CSSProperties = { fontSize: 12, color: "#8a4b00", margin: "6px 0" };
const noticeList: React.CSSProperties = { fontSize: 12, color: "#8a4b00", margin: "6px 0", paddingLeft: 18 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "6px 0", flexWrap: "wrap" };
const label: React.CSSProperties = { width: 110, fontSize: 12, color: "#42505f" };
const input: React.CSSProperties = {
  flex: 1,
  padding: "3px 6px",
  border: "1px solid #cdd5de",
  borderRadius: 3,
  fontSize: 12,
};
const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 11, color: "#42505f" };
const box: React.CSSProperties = {
  border: "1px solid #dfe6ee",
  borderRadius: 4,
  padding: "8px 10px",
  marginBottom: 10,
};
const resultBox: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid #b9dcc4",
  borderRadius: 4,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};
const pre: React.CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontFamily: "monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 96,
  overflow: "auto",
  color: "#42505f",
};
const smallBtn: React.CSSProperties = {
  padding: "1px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 3,
  background: "#fff",
  fontSize: 11,
  cursor: "pointer",
};
const addBtn: React.CSSProperties = {
  padding: "4px 10px",
  border: "1px dashed #9db3c8",
  borderRadius: 4,
  background: "#fff",
  fontSize: 12,
  cursor: "pointer",
  color: "#0b5cad",
};
const warnBadge: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 8,
  background: "#fdf0e3",
  border: "1px solid #e0b884",
  color: "#8a4b00",
};
