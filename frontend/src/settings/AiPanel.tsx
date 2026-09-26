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
import { desktop, type AiProviderEntry, type AiProvidersConfig } from "../desktopBridge";

export function AiPanel() {
  const { t } = useI18n();
  const d = desktop();
  const [config, setConfig] = useState<AiProvidersConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 提供元 id → 入力中の鍵。画面に残さないよう、保存したら消す。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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

  const setDefault = async (capability: string, providerId: string) => {
    if (!config || !d.aiProvidersSet) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await d.aiProvidersSet({
        providers: config.providers,
        defaults: { ...config.defaults, [capability]: providerId },
      });
      if (!r.ok) setError(r.problems.join(" / "));
      else setMessage(t("settings.ai.defaultSaved"));
      await refresh();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
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
              <span style={{ fontSize: 11, color: "#6b7785" }}>{`kind=${p.kind}`}</span>
            </div>

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
          </div>
        ))}
        <p style={help}>{t("settings.ai.sec.providers.help")}</p>
      </section>

      {/* 読み込み時に捨てた設定。**黙って捨てない。** */}
      {config?.problems.length ? (
        <p style={warn} data-testid="ai-config-problems">
          {`${t("settings.ai.configProblems")} ${config.problems.join(" / ")}`}
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
const notice: React.CSSProperties = { fontSize: 12, color: "#6b7785" };
const warn: React.CSSProperties = { fontSize: 12, color: "#8a4b00", margin: "6px 0" };
const noticeList: React.CSSProperties = {
  fontSize: 12,
  color: "#8a4b00",
  margin: "6px 0 0",
  paddingLeft: 18,
  lineHeight: 1.7,
};
