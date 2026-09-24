/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 外部 AI（Gemini）の設定（fw/art-of-imaging-design.md §2）。
 *
 * <h3>なぜ registry.ts のフィールドにしないのか</h3>
 * 通常の設定は `GET/PUT /api/settings` を通って H2 の平文行になり、
 * **`GET /api/settings` は全件を丸ごと返す**。API キーをそこに置くと、レンダラ・
 * プラグイン・DB バックアップ・ログの全部から平文で読めてしまう。
 * よってキーだけは backend を経由させず、Electron main の `safeStorage`
 * （Windows=DPAPI / macOS=Keychain / Linux=libsecret|kwallet）へ預ける。
 *
 * <h3>書き込み専用</h3>
 * 保存した値を読み戻す口は用意していない（IPC 自体が存在しない）。
 * UI が知れるのは「入っているか」「永続化できたか」「OS の暗号化が使えるか」だけ。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { desktop, type SecretStatus } from "../desktopBridge";
import { AI_HOST } from "../plugins/pluginAiApi";

const SECRET_KEY = "ai.gemini.apiKey";
/** モデル ID と API バージョンは平文で構わないので通常の設定に置く。 */
export const AI_MODEL_KEY = "ai.gemini.model";
export const AI_API_VERSION_KEY = "ai.gemini.apiVersion";
/** 既定は画像生成に対応したモデル。ユーザーが切り替えられるようにテキストで持つ。 */
export const AI_MODEL_DEFAULT = "gemini-3.1-flash-image";
export const AI_API_VERSION_DEFAULT = "v1beta";

export function AiPanel({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const d = desktop();
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!d?.secretStatus) return;
    try {
      setStatus(await d.secretStatus(SECRET_KEY));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  }, [d, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!d?.secretSet) {
    // web モードには Electron が無く、鍵の預け先も無い。できないことをそのまま言う。
    return <p style={notice} data-testid="ai-desktop-only">{t("settings.ai.desktopOnly")}</p>;
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await d.secretSet!(SECRET_KEY, draft.trim());
      if (!r.ok) {
        setError(t(`settings.ai.err.${r.reason ?? "unknown"}`));
      } else {
        setDraft("");
        // 🔴 「保存した」で終わらせない。永続化できていない場合はそれを必ず言う
        //    （次の起動で消えるので、黙っていると「設定したのに使えない」になる）。
        setMessage(r.persisted ? t("settings.ai.saved") : t("settings.ai.savedSessionOnly"));
      }
      await refresh();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(t("settings.ai.clearConfirm"))) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await d.secretClear!(SECRET_KEY);
      await refresh();
      setMessage(t("settings.ai.cleared"));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
      d.refocus?.();
    }
  };

  return (
    <div data-testid="ai-panel">
      <section style={{ marginBottom: 22 }}>
        <h3 style={sectionTitle}>{t("settings.ai.sec.key")}</h3>

        <div style={row}>
          <span style={label}>{t("settings.ai.state")}</span>
          <span style={value} data-testid="ai-key-state">
            {status?.hasValue ? (
              <b style={{ color: "#2e7d32" }}>{t("settings.ai.state.set")}</b>
            ) : (
              <span style={{ color: "#6b7785" }}>{t("settings.ai.state.unset")}</span>
            )}
            {status?.hasValue && !status.persisted ? (
              <span style={{ color: "#8a4b00" }}>{` — ${t("settings.ai.state.sessionOnly")}`}</span>
            ) : null}
          </span>
        </div>

        {status && !status.encryptionAvailable ? (
          <p style={warn} data-testid="ai-no-keyring">{t("settings.ai.noKeyring")}</p>
        ) : null}

        <div style={row}>
          <span style={label}>{t("settings.ai.key")}</span>
          <input
            type="password"
            style={input}
            value={draft}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder={status?.hasValue ? "••••••••••••" : ""}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="ai-key-input"
          />
          <button style={btn} disabled={busy || draft.trim().length === 0} onClick={save} data-testid="ai-key-save">
            {t("common.save")}
          </button>
          <button style={btn} disabled={busy || !status?.hasValue} onClick={clear} data-testid="ai-key-clear">
            {t("settings.ai.clear")}
          </button>
        </div>
        <p style={help}>{t("settings.ai.key.help")}</p>

        {message ? <p style={{ color: "#2e7d32", fontSize: 12 }} data-testid="ai-message">{message}</p> : null}
        {error ? <p style={{ color: "#b00020", fontSize: 12 }} data-testid="ai-error">{error}</p> : null}
      </section>

      <section style={{ marginBottom: 22 }}>
        <h3 style={sectionTitle}>{t("settings.ai.sec.model")}</h3>
        <div style={row}>
          <span style={label}>{t("settings.ai.model")}</span>
          <input
            style={input}
            spellCheck={false}
            value={values[AI_MODEL_KEY] ?? AI_MODEL_DEFAULT}
            onChange={(e) => onChange(AI_MODEL_KEY, e.target.value)}
            data-testid="ai-model-input"
          />
        </div>
        <p style={help}>{t("settings.ai.model.help")}</p>
        <div style={row}>
          <span style={label}>{t("settings.ai.apiVersion")}</span>
          <input
            style={{ ...input, maxWidth: 120 }}
            spellCheck={false}
            value={values[AI_API_VERSION_KEY] ?? AI_API_VERSION_DEFAULT}
            onChange={(e) => onChange(AI_API_VERSION_KEY, e.target.value)}
            data-testid="ai-apiversion-input"
          />
        </div>
        <div style={row}>
          <span style={label}>{t("settings.ai.host")}</span>
          <span style={{ ...value, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
            {AI_HOST}
          </span>
        </div>
      </section>

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
