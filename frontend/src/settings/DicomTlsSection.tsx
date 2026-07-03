/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { fetchTlsConfig, saveTlsConfig, type TlsConfig } from "../api";
import { useI18n } from "../i18n/i18n";

/**
 * グローバル DIMSE TLS（相互 TLS）設定セクション。
 *
 * <p>通信先の TLS チェックを ON にしたノードへ接続する際に共通で使う自局の鍵材料
 * （キーストア＝鍵+証明書 / トラストストア＝信頼する相手の証明書）を編集する。SCU 送信（Echo/Send/QR）は
 * 保存後すぐ反映され、SCP 受信リスナーの TLS 有効化はアプリ再起動後に反映される。
 */
export function DicomTlsSection() {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<TlsConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTlsConfig()
      .then((c) => { if (!cancelled) setCfg(c); })
      .catch(() => { if (!cancelled) setCfg(null); });
    return () => { cancelled = true; };
  }, []);

  const set = <K extends keyof TlsConfig>(key: K, val: TlsConfig[K]) => {
    setCfg((c) => (c ? { ...c, [key]: val } : c));
    setDirty(true);
    setSavedMsg(null);
  };

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      const saved = await saveTlsConfig(cfg);
      setCfg(saved);
      setDirty(false);
      setSavedMsg(t("settings.tls.saved"));
    } catch (e) {
      setSavedMsg(t("common.fetchError", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) return null;

  // カンマ区切りテキスト ⇔ string[]（空要素は捨てる）。
  const listToText = (a: string[]) => a.join(", ");
  const textToList = (s: string) => s.split(",").map((x) => x.trim()).filter((x) => x !== "");

  return (
    <div style={{ marginTop: 26, borderTop: "1px solid #e6eaee", paddingTop: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#33404d", marginBottom: 4 }}>
        {t("settings.tls.title")}
      </div>
      <p style={{ fontSize: 12.5, color: "#6b7785", marginTop: 0 }}>{t("settings.tls.help")}</p>

      <label style={rowCheck}>
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        {t("settings.tls.enabled")}
      </label>

      <div style={grid}>
        <label style={lbl}>{t("settings.tls.port")}</label>
        <input style={{ ...input, width: 100 }} type="number" value={cfg.port}
          onChange={(e) => set("port", Number(e.target.value) || 0)} />

        <label style={lbl}>{t("settings.tls.keyStore")}</label>
        <div style={inline}>
          <input style={{ ...input, flex: 1 }} value={cfg.keyStore} spellCheck={false} placeholder="/path/to/keystore.p12"
            onChange={(e) => set("keyStore", e.target.value)} />
          <select style={sel} value={cfg.keyStoreType} onChange={(e) => set("keyStoreType", e.target.value)}>
            <option value="PKCS12">PKCS12</option>
            <option value="JKS">JKS</option>
          </select>
        </div>

        <label style={lbl}>{t("settings.tls.keyStorePassword")}</label>
        <input style={{ ...input, width: 240 }} type="password" value={cfg.keyStorePassword} autoComplete="off"
          onChange={(e) => set("keyStorePassword", e.target.value)} />

        <label style={lbl}>{t("settings.tls.trustStore")}</label>
        <div style={inline}>
          <input style={{ ...input, flex: 1 }} value={cfg.trustStore} spellCheck={false} placeholder="/path/to/truststore.p12"
            onChange={(e) => set("trustStore", e.target.value)} />
          <select style={sel} value={cfg.trustStoreType} onChange={(e) => set("trustStoreType", e.target.value)}>
            <option value="PKCS12">PKCS12</option>
            <option value="JKS">JKS</option>
          </select>
        </div>

        <label style={lbl}>{t("settings.tls.trustStorePassword")}</label>
        <input style={{ ...input, width: 240 }} type="password" value={cfg.trustStorePassword} autoComplete="off"
          onChange={(e) => set("trustStorePassword", e.target.value)} />

        <label style={lbl}>{t("settings.tls.protocols")}</label>
        <input style={{ ...input, flex: 1 }} value={listToText(cfg.protocols)} spellCheck={false}
          placeholder="TLSv1.2, TLSv1.3" onChange={(e) => set("protocols", textToList(e.target.value))} />

        <label style={lbl}>{t("settings.tls.ciphers")}</label>
        <textarea style={{ ...input, flex: 1, minHeight: 44, resize: "vertical", fontFamily: "monospace" }}
          value={listToText(cfg.cipherSuites)} spellCheck={false}
          placeholder="TLS_AES_128_GCM_SHA256, TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"
          onChange={(e) => set("cipherSuites", textToList(e.target.value))} />
      </div>

      <label style={{ ...rowCheck, marginTop: 8 }}>
        <input type="checkbox" checked={cfg.needClientAuth} onChange={(e) => set("needClientAuth", e.target.checked)} />
        {t("settings.tls.needClientAuth")}
      </label>

      <div style={{ marginTop: 10, fontSize: 12, color: cfg.usable ? "#2e7d32" : "#9aa4ad" }}>
        {t("settings.tls.usable")}: {cfg.usable ? t("settings.tls.usable.yes") : t("settings.tls.usable.no")}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <button onClick={save} disabled={saving || !dirty} style={{
          ...saveBtn,
          background: saving || !dirty ? "#9fb6cf" : "#0b5cad",
          cursor: saving || !dirty ? "default" : "pointer",
        }}>
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {savedMsg && <span style={{ fontSize: 12, color: "#2e5d27" }}>{savedMsg}</span>}
        <span style={{ fontSize: 11.5, color: "#9aa4ad" }}>{t("settings.tls.restartNote")}</span>
      </div>
    </div>
  );
}

const rowCheck: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 13, cursor: "pointer" };
const grid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: "8px 12px", marginTop: 10,
};
const lbl: React.CSSProperties = { fontSize: 12.5, color: "#33404d", whiteSpace: "nowrap" };
const inline: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const input: React.CSSProperties = {
  minWidth: 0, padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13,
};
const sel: React.CSSProperties = { ...input, width: 100, flex: "none" };
const saveBtn: React.CSSProperties = { padding: "6px 16px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13 };
