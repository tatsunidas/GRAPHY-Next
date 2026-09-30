/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 外部 AI。設計: `fw/ai-routing-design.md`
 *
 * <h3>提供元ではなく「用途」で選ぶ</h3>
 * 🔑 **提供元を平らに並べて選ばせない。** 提供元によって**できることが違う**
 * （画像を生成しない提供元がある）ので、用途ごとに既定を選ぶ形にしてある。
 * 使えない組み合わせは選択肢に出さない——**選んだあとで失敗するのが一番わかりにくい。**
 *
 * <h3>鍵は提供元ごと</h3>
 * 値は OS のキーチェーンに預け、**読み出す経路は作らない**（有無だけを問い合わせる）。
 */
import React, { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { desktop, type AiProviderEntry, type AiProvidersConfig, type AiTestResult } from "../desktopBridge";
import { AiProviderForm, describeProblem, emptyDraft, toDraft, type ProviderDraft } from "./AiProviderForm";

export function AiPanel() {
  const { t } = useI18n();
  const d = desktop();
  const [config, setConfig] = useState<AiProvidersConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 提供元 id → 入力中の鍵。画面に残さないよう、保存したら消す。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 提供元 id → 直近の疎通確認の結果。 */
  const [tests, setTests] = useState<Record<string, AiTestResult | "running">>({});
  /** 編集中の提供元（`null` なら編集していない）。 */
  const [editing, setEditing] = useState<{ draft: ProviderDraft; isNew: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!d?.aiProvidersGet) return;
    try {
      setConfig(await d.aiProvidersGet());
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  }, [d, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!d?.secretSet || !d.aiProvidersGet) {
    // web モードには Electron が無く、鍵の預け先も無い。できないことをそのまま言う。
    return <p style={notice} data-testid="ai-desktop-only">{t("settings.ai.desktopOnly")}</p>;
  }

  const saveKey = async (p: AiProviderEntry) => {
    const draft = (drafts[p.id] ?? "").trim();
    if (!draft || !p.secretKey) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await d.secretSet!(p.secretKey, draft);
      if (!r.ok) {
        setError(t(`settings.ai.err.${r.reason ?? "unknown"}`));
      } else {
        setDrafts((s) => ({ ...s, [p.id]: "" }));
        // 🔴 「保存した」で終わらせない。永続化できていない場合はそれを必ず言う
        //    （次の起動で消えるので、黙っていると「設定したのに使えない」になる）。
        setMessage(r.persisted ? t("settings.ai.saved") : t("settings.ai.savedSessionOnly"));
      }
      await refresh();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
      d.refocus?.();
    }
  };

  const clearKey = async (p: AiProviderEntry) => {
    if (!p.secretKey) return;
    if (!window.confirm(t("settings.ai.clearConfirm"))) return;
    setBusy(true);
    try {
      await d.secretClear!(p.secretKey);
      setMessage(t("settings.ai.cleared"));
      await refresh();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
      d.refocus?.();
    }
  };

  /**
   * 疎通確認を走らせる。
   *
   * <p>渡すのは**提供元と用途だけ**。送る指示と画像は main が持つ定数なので、
   * ここから患者の画像が出ることはない。
   */
  const runTest = async (p: AiProviderEntry, capability: string) => {
    if (!d.aiTestConnection) return;
    setTests((s) => ({ ...s, [p.id]: "running" }));
    try {
      const r = await d.aiTestConnection(p.id, capability as never);
      setTests((s) => ({ ...s, [p.id]: r }));
    } catch (e) {
      setTests((s) => ({ ...s, [p.id]: { ok: false, verdict: "network", error: String(e) } }));
    }
  };

  /**
   * 用途の既定を切り替える。
   *
   * <p>🔑 **提供元の一覧を送らない専用の口を使う。** 一覧を送る口は「新しい送信先が
   * 増えるかもしれない」ので main が確認を出す——既定を変えるだけで確認が出るのは煩わしい。
   */
  const setDefault = async (capability: string, providerId: string) => {
    if (!config || !d.aiDefaultsSet) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await d.aiDefaultsSet({ [capability]: providerId });
      if (!r.ok) setError(r.problems.join(" / "));
      else setMessage(t("settings.ai.defaultSaved"));
      await refresh();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  /** 提供元を 1 件保存する（追加も編集も同じ経路）。 */
  const saveProvider = async (entry: AiProviderEntry) => {
    if (!config || !d.aiProvidersSet) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const others = config.providers.filter((p) => p.id !== entry.id);
      const r = await d.aiProvidersSet({ providers: [...others, entry], defaults: config.defaults });
      if (r.canceled) {
        setMessage(t("settings.ai.provider.canceled"));
      } else if (!r.ok) {
        setError(r.problems.map((x) => describeProblem(x, t)).join(" / "));
        return; // フォームを開いたままにして直させる
      } else {
        setMessage(t("settings.ai.provider.saved", { label: entry.label }));
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
      d.refocus?.();
    }
  };

  /**
   * 提供元を削除する。
   *
   * <p>🔴 **鍵も一緒に消す。** 残すと、同じ id で別の会社の提供元を作ったときに
   * **前の会社の鍵がそちらへ送られる**（「鍵を提供元間で共用しない」の違反）。
   * <p>🔴 削除でその用途の既定が別の提供元へ移ることがある。**黙って送り先が変わるのは最悪**なので、
   * 移った先を画面で言う。
   */
  const deleteProvider = async (p: AiProviderEntry) => {
    if (!config || !d.aiProvidersSet) return;
    if (!window.confirm(t("settings.ai.provider.deleteConfirm", { label: p.label }))) {
      d.refocus?.();
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const rest = config.providers.filter((x) => x.id !== p.id);
      if (rest.length === 0) {
        setError(t("settings.ai.provider.deleteLast"));
        return;
      }
      const r = await d.aiProvidersSet({ providers: rest, defaults: config.defaults });
      if (r.canceled) return;
      if (!r.ok) {
        setError(r.problems.map((x) => describeProblem(x, t)).join(" / "));
        return;
      }
      if (p.hasApiKey && p.secretKey) await d.secretClear?.(p.secretKey);
      const next = await d.aiProvidersGet!();
      const moved = Object.entries(next.defaults)
        .filter(([cap, id]) => config.defaults[cap] === p.id && id !== p.id)
        .map(([cap, id]) => `${t(`settings.ai.cap.${cap}`)} → ${next.providers.find((x) => x.id === id)?.label ?? id}`);
      setConfig(next);
      setTests((s) => ({ ...s, [p.id]: undefined as never }));
      setMessage(
        moved.length > 0
          ? t("settings.ai.provider.deletedMoved", { label: p.label, moved: moved.join(" / ") })
          : t("settings.ai.provider.deleted", { label: p.label }),
      );
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
      d.refocus?.();
    }
  };

  const capabilities = config?.capabilities ?? [];

  return (
    <div data-testid="ai-panel">
      {/* ── 用途ごとの既定 ─────────────────────────────────────────────── */}
      <section style={{ marginBottom: 22 }}>
        <h3 style={sectionTitle}>{t("settings.ai.sec.routing")}</h3>
        {capabilities.map((cap) => {
          // 🔴 **その用途を扱える提供元だけを出す。** 選べてしまうと、選んだあとで失敗する。
          const usable = (config?.providers ?? []).filter((p) => p.models[cap]);
          const current = config?.defaults[cap] ?? "";
          return (
            <div key={cap} style={row}>
              <span style={label}>{t(`settings.ai.cap.${cap}`)}</span>
              {usable.length === 0 ? (
                <span style={{ ...value, color: "#8a4b00" }} data-testid={`ai-default-${cap}-none`}>
                  {t("settings.ai.cap.noProvider")}
                </span>
              ) : (
                <>
                  <select
                    style={{ ...input, maxWidth: 260 }}
                    value={current}
                    disabled={busy}
                    onChange={(e) => void setDefault(cap, e.target.value)}
                    data-testid={`ai-default-${cap}`}
                  >
                    {usable.map((p) => (
                      <option key={p.id} value={p.id}>
                        {`${p.label} — ${p.models[cap]}`}
                      </option>
                    ))}
                  </select>
                  {!usable.find((p) => p.id === current)?.hasApiKey ? (
                    <span style={{ fontSize: 11, color: "#8a4b00" }}>{t("settings.ai.cap.noKey")}</span>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
        <p style={help}>{t("settings.ai.sec.routing.help")}</p>
      </section>

      {/* ── 提供元ごとの鍵と、できること ──────────────────────────────── */}
      <section style={{ marginBottom: 22 }}>
        <h3 style={sectionTitle}>{t("settings.ai.sec.providers")}</h3>
        {(config?.providers ?? []).map((p) => (
          <div key={p.id} style={providerBox} data-testid={`ai-provider-${p.id}`}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <b style={{ fontSize: 12 }}>{p.label}</b>
              <span style={mono}>{p.endpoint}</span>
              <span style={{ fontSize: 11, color: "#6b7785" }}>
                {`kind=${p.kind}${p.pathStyle ? `/${p.pathStyle}` : ""}`}
              </span>
              {/* 🔴 平文で出る宛先は必ず印を出す（院内に自分で立てたサーバだけ起こりうる）。 */}
              {p.plaintext ? (
                <span style={warnBadge} data-testid={`ai-plaintext-${p.id}`} title={t("settings.ai.plaintext.help")}>
                  {t("settings.ai.plaintext")}
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              <button
                style={smallBtn}
                disabled={busy}
                onClick={() => setEditing({ draft: toDraft(p, capabilities), isNew: false })}
                data-testid={`ai-provider-edit-${p.id}`}
              >
                {t("settings.ai.provider.edit")}
              </button>
              <button
                style={{ ...smallBtn, color: "#b00020" }}
                disabled={busy}
                title={t("common.delete")}
                onClick={() => void deleteProvider(p)}
                data-testid={`ai-provider-delete-${p.id}`}
              >
                ✕
              </button>
            </div>

            {/* 編集中はこの提供元の下にフォームを開く（別ウィンドウにしない）。 */}
            {editing && !editing.isNew && editing.draft.id === p.id ? (
              <AiProviderForm
                draft={editing.draft}
                isNew={false}
                capabilities={capabilities}
                others={(config?.providers ?? []).filter((x) => x.id !== p.id)}
                defaults={config?.defaults ?? {}}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(entry) => void saveProvider(entry)}
              />
            ) : null}

            {/* できること。**無い用途は出さずに「使えない」と書く**——推測させない。 */}
            <div style={{ display: "flex", gap: 6, margin: "4px 0", flexWrap: "wrap" }}>
              {capabilities.map((cap) => (
                <span key={cap} style={p.models[cap] ? badgeOn : badgeOff}>
                  {`${t(`settings.ai.cap.${cap}`)}: ${p.models[cap] ?? t("settings.ai.cap.unsupported")}`}
                </span>
              ))}
            </div>

            <div style={row}>
              <span style={label}>{t("settings.ai.state")}</span>
              <span style={value} data-testid={`ai-key-state-${p.id}`}>
                {p.hasApiKey ? (
                  <b style={{ color: "#2e7d32" }}>{t("settings.ai.state.set")}</b>
                ) : (
                  <span style={{ color: "#6b7785" }}>{t("settings.ai.state.unset")}</span>
                )}
              </span>
            </div>
            <div style={row}>
              <span style={label}>{t("settings.ai.key")}</span>
              <input
                type="password"
                style={input}
                value={drafts[p.id] ?? ""}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                placeholder={p.hasApiKey ? "••••••••••••" : ""}
                onChange={(e) => setDrafts((s) => ({ ...s, [p.id]: e.target.value }))}
                data-testid={`ai-key-input-${p.id}`}
              />
              <button
                style={btn}
                disabled={busy || (drafts[p.id] ?? "").trim().length === 0}
                onClick={() => void saveKey(p)}
                data-testid={`ai-key-save-${p.id}`}
              >
                {t("common.save")}
              </button>
              <button
                style={btn}
                disabled={busy || !p.hasApiKey}
                onClick={() => void clearKey(p)}
                data-testid={`ai-key-clear-${p.id}`}
              >
                {t("settings.ai.clear")}
              </button>
            </div>

            {/* ── 疎通確認 ───────────────────────────────────────────────
                🔑 **私たちが全社を事前検証することはできない**ので、利用者が自分で確かめる。
                送るのは 1×1 の白い画像と短い指示だけ（患者の画像は使わない）。 */}
            <div style={row}>
              <span style={label}>{t("settings.ai.test")}</span>
              {capabilities.filter((cap) => p.models[cap]).map((cap) => (
                <button
                  key={cap}
                  style={btn}
                  disabled={busy || !p.hasApiKey || tests[p.id] === "running"}
                  onClick={() => void runTest(p, cap)}
                  // 🔴 画像生成の疎通は 1 枚生成＝課金。押す前に分かるようにする。
                  title={cap === "image-to-image" ? t("settings.ai.test.i2iCost") : undefined}
                  data-testid={`ai-test-${p.id}-${cap}`}
                >
                  {cap === "image-to-image"
                    ? `${t(`settings.ai.cap.${cap}`)} ⚠`
                    : t(`settings.ai.cap.${cap}`)}
                </button>
              ))}
              {tests[p.id] === "running" ? (
                <span style={{ fontSize: 11, color: "#6b7785" }}>{t("settings.ai.test.running")}</span>
              ) : null}
            </div>
            {tests[p.id] && tests[p.id] !== "running" ? (
              <TestReport result={tests[p.id] as AiTestResult} id={p.id} t={t} />
            ) : null}
          </div>
        ))}
        {editing?.isNew ? (
          <AiProviderForm
            draft={editing.draft}
            isNew
            capabilities={capabilities}
            others={config?.providers ?? []}
            defaults={config?.defaults ?? {}}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(entry) => void saveProvider(entry)}
          />
        ) : (
          <button
            style={addBtn}
            disabled={busy}
            onClick={() => setEditing({ draft: emptyDraft(capabilities), isNew: true })}
            data-testid="ai-provider-add"
          >
            {`＋ ${t("settings.ai.provider.add")}`}
          </button>
        )}
        <p style={help}>{t("settings.ai.sec.providers.help")}</p>
        <p style={help}>{t("settings.ai.test.help")}</p>
      </section>

      {/* 読み込み時に捨てた設定。**黙って捨てない。** */}
      {config?.problems.length ? (
        <p style={warn} data-testid="ai-config-problems">
          {`${t("settings.ai.configProblems")} ${config.problems.map((x) => describeProblem(x, t)).join(" / ")}`}
        </p>
      ) : null}
      {message ? <p style={{ color: "#2e7d32", fontSize: 12 }} data-testid="ai-message">{message}</p> : null}
      {error ? <p style={{ color: "#b00020", fontSize: 12 }} data-testid="ai-error">{error}</p> : null}

      {/* 🔴 ここは畳まない・隠さない。患者画像を第三者クラウドへ出す機能の設定画面なので、
          注意書きは設定そのものと同じ高さに置く。 */}
      <section>
        <h3 style={sectionTitle}>{t("settings.ai.sec.privacy")}</h3>
        <ul style={noticeList} data-testid="ai-privacy-notice">
          <li>{t("settings.ai.privacy.egress")}</li>
          <li>{t("settings.ai.privacy.freeTier")}</li>
          <li>{t("settings.ai.privacy.anonymized")}</li>
          <li>{t("settings.ai.privacy.burnedIn")}</li>
          <li>{t("settings.ai.privacy.researchOnly")}</li>
        </ul>
      </section>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 13,
  margin: "0 0 8px",
  paddingBottom: 4,
  borderBottom: "1px solid #dfe6ee",
  color: "#5a6b7d",
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "6px 0" };
const label: React.CSSProperties = { width: 150, flex: "0 0 auto", fontSize: 12, color: "#5a6b7d" };
const value: React.CSSProperties = { fontSize: 12, color: "#22303d" };
const mono: React.CSSProperties = {
  fontSize: 11,
  color: "#5a6b7d",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "4px 6px",
  fontSize: 12,
  border: "1px solid #b9c6d4",
  borderRadius: 4,
};
const btn: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 12,
  border: "1px solid #b9c6d4",
  borderRadius: 4,
  background: "#f4f7fa",
  cursor: "pointer",
  flex: "0 0 auto",
};
const providerBox: React.CSSProperties = {
  border: "1px solid #dfe6ee",
  borderRadius: 4,
  padding: "8px 10px",
  margin: "8px 0",
};
const badgeBase: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  borderRadius: 10,
  border: "1px solid transparent",
};
const badgeOn: React.CSSProperties = { ...badgeBase, background: "#e8f5e9", color: "#2e7d32", borderColor: "#c8e6c9" };
const badgeOff: React.CSSProperties = { ...badgeBase, background: "#f4f7fa", color: "#8a949f", borderColor: "#dfe6ee" };
const help: React.CSSProperties = { fontSize: 11, color: "#6b7785", margin: "2px 0 0 158px" };
/**
 * 疎通確認の結果。**「何を直せばよいか」を先に出す。**
 *
 * <p>🔴 返ってくるヘッダは名前だけ（値は main が返さない）。ここで値を出す実装を足さないこと。
 */
function TestReport({ result, id, t }: { result: AiTestResult; id: string; t: (k: string, v?: Record<string, string | number>) => string }) {
  const good = result.ok && result.verdict === "reachable";
  return (
    <div style={testBox} data-testid={`ai-test-result-${id}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <b style={{ color: good ? "#2e7d32" : "#b00020", fontSize: 12 }} data-testid={`ai-test-verdict-${id}`}>
          {t(`settings.ai.test.verdict.${result.verdict}`)}
        </b>
        {result.status ? <span style={mono}>{`HTTP ${result.status}`}</span> : null}
        {result.elapsedMs != null ? <span style={mono}>{`${result.elapsedMs} ms`}</span> : null}
        {result.plaintext ? <span style={warnBadge}>{t("settings.ai.plaintext")}</span> : null}
      </div>
      {result.requestLine ? <div style={mono}>{result.requestLine}</div> : null}
      {result.headerNames?.length ? (
        <div style={{ ...mono, color: "#6b7785" }}>
          {t("settings.ai.test.headers", { names: result.headerNames.join(", ") })}
        </div>
      ) : null}
      {result.text ? <div style={{ fontSize: 11 }}>{result.text}</div> : null}
      {result.imageBytes ? (
        <div style={{ fontSize: 11 }}>{t("settings.ai.test.gotImage", { bytes: result.imageBytes })}</div>
      ) : null}
      {result.error ? <div style={{ fontSize: 11, color: "#b00020" }}>{result.error}</div> : null}
      {result.bodyPreview && !result.ok ? (
        <pre style={pre}>{result.bodyPreview}</pre>
      ) : null}
    </div>
  );
}

const testBox: React.CSSProperties = {
  margin: "4px 0 0 148px",
  padding: "6px 8px",
  background: "#f7f9fb",
  border: "1px solid #dfe6ee",
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

const notice: React.CSSProperties = { fontSize: 12, color: "#6b7785" };
const warn: React.CSSProperties = { fontSize: 12, color: "#8a4b00", margin: "6px 0" };
const noticeList: React.CSSProperties = {
  fontSize: 12,
  color: "#8a4b00",
  margin: "6px 0 0",
  paddingLeft: 18,
  lineHeight: 1.7,
};
