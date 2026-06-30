/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { echoDicom, fetchRemoteAes, type RemoteAe } from "../api";
import { fetchSettings, saveSettings } from "./settingsApi";
import { emitRemoteAesChanged } from "../remoteAeEvents";
import { useI18n } from "../i18n/i18n";

/** Settings(H2) に送信先 Remote AE を JSON 配列で保存するキー。backend の REMOTE_AES_KEY と一致。 */
const REMOTE_AES_KEY = "dicom.remoteAes";

type Row = { aeTitle: string; host: string; port: string };
type EchoState = "idle" | "running" | "ok" | "fail";

/**
 * 環境設定の「DICOM 送信先（Remote AE）」カスタムパネル。
 *
 * <p>GUI から送信先（AE タイトル / ホスト / ポート）を追加・編集・削除し、Settings(H2) に保存する。
 * 保存分は backend で application.yml の {@code remote-aes} とマージされ、送信ダイアログの
 * ドロップダウンに出る。行ごとに C-ECHO 疎通確認ができる。
 */
export function RemoteAePanel() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [yamlAes, setYamlAes] = useState<RemoteAe[]>([]); // YAML 由来（読み取り専用・参考表示）
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [echo, setEcho] = useState<Record<number, EchoState>>({});

  // 初期ロード: Settings 保存分（編集対象）と、マージ済み全件から YAML 由来分を抽出（参考表示）。
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSettings(), fetchRemoteAes().catch(() => [] as RemoteAe[])])
      .then(([settings, merged]) => {
        if (cancelled) return;
        let stored: RemoteAe[] = [];
        const raw = settings[REMOTE_AES_KEY];
        if (raw) {
          try {
            stored = JSON.parse(raw) as RemoteAe[];
          } catch {
            stored = [];
          }
        }
        const storedAets = new Set(stored.map((a) => a.aeTitle));
        setRows(stored.map((a) => ({ aeTitle: a.aeTitle ?? "", host: a.host ?? "", port: String(a.port ?? "") })));
        // マージ結果のうち Settings に無い＝YAML 由来（読み取り専用で参考表示）。
        setYamlAes(merged.filter((a) => !storedAets.has(a.aeTitle)));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (i: number, key: keyof Row, val: string) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
    setDirty(true);
    setSavedMsg(null);
    setEcho((e) => ({ ...e, [i]: "idle" }));
  };

  const addRow = () => {
    setRows((rs) => [...rs, { aeTitle: "", host: "", port: "104" }]);
    setDirty(true);
    setSavedMsg(null);
  };

  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
    setDirty(true);
    setSavedMsg(null);
  };

  const rowValid = (r: Row) => r.aeTitle.trim() !== "" && r.host.trim() !== "" && /^\d+$/.test(r.port.trim());

  const save = async () => {
    // 有効行だけを保存（空行は捨てる）。
    const clean = rows
      .filter(rowValid)
      .map((r) => ({ aeTitle: r.aeTitle.trim(), host: r.host.trim(), port: Number(r.port) }));
    setSaving(true);
    setSavedMsg(null);
    try {
      await saveSettings({ [REMOTE_AES_KEY]: JSON.stringify(clean) });
      setDirty(false);
      setSavedMsg(t("settings.remoteAe.saved", { count: clean.length }));
      // QR ウィンドウ等の別ウィンドウへ「送信先が変わった」を通知（全タブ再構築を促す）。
      emitRemoteAesChanged();
    } catch (e) {
      setSavedMsg(t("common.fetchError", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const runEcho = async (i: number) => {
    const r = rows[i];
    if (!rowValid(r)) return;
    setEcho((e) => ({ ...e, [i]: "running" }));
    try {
      const res = await echoDicom({ host: r.host.trim(), port: Number(r.port), calledAet: r.aeTitle.trim() });
      setEcho((e) => ({ ...e, [i]: res.success ? "ok" : "fail" }));
    } catch {
      setEcho((e) => ({ ...e, [i]: "fail" }));
    }
  };

  const echoLabel = (s: EchoState | undefined) =>
    s === "running" ? "…" : s === "ok" ? "✓" : s === "fail" ? "✕" : t("send.echo");
  const echoColor = (s: EchoState | undefined) => (s === "ok" ? "#2e7d32" : s === "fail" ? "#b00020" : "#33404d");

  if (!loaded) return <div style={{ color: "#888" }}>{t("common.loading")}</div>;

  return (
    <div>
      <p style={{ fontSize: 13, color: "#6b7785", marginTop: 0 }}>{t("settings.remoteAe.help")}</p>

      <div style={headerRow}>
        <span style={{ ...cell, flex: 2 }}>{t("send.aeTitle")}</span>
        <span style={{ ...cell, flex: 3 }}>{t("send.host")}</span>
        <span style={{ ...cell, width: 80, flex: "none" }}>{t("send.port")}</span>
        <span style={{ width: 150, flex: "none" }} />
      </div>

      {rows.length === 0 && <div style={{ color: "#888", fontSize: 13, padding: "6px 0" }}>{t("settings.remoteAe.empty")}</div>}

      {rows.map((r, i) => (
        <div key={i} style={dataRow}>
          <input style={{ ...input, flex: 2 }} value={r.aeTitle} placeholder="AET" spellCheck={false}
            onChange={(e) => update(i, "aeTitle", e.target.value)} />
          <input style={{ ...input, flex: 3 }} value={r.host} placeholder="host / IP" spellCheck={false}
            onChange={(e) => update(i, "host", e.target.value)} />
          <input style={{ ...input, width: 80, flex: "none" }} value={r.port} placeholder="104" spellCheck={false}
            onChange={(e) => update(i, "port", e.target.value)} />
          <div style={{ width: 150, flex: "none", display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button style={{ ...smallBtn, color: echoColor(echo[i]) }} disabled={!rowValid(r) || echo[i] === "running"}
              title={t("send.echo")} onClick={() => void runEcho(i)}>
              {echoLabel(echo[i])}
            </button>
            <button style={{ ...smallBtn, color: "#b00020" }} title={t("common.delete")} onClick={() => removeRow(i)}>
              ✕
            </button>
          </div>
        </div>
      ))}

      <button onClick={addRow} style={addBtn}>＋ {t("common.add")}</button>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
        <button onClick={save} disabled={saving || !dirty} style={{
          ...saveBtn,
          background: saving || !dirty ? "#9fb6cf" : "#0b5cad",
          cursor: saving || !dirty ? "default" : "pointer",
        }}>
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {savedMsg && <span style={{ fontSize: 12, color: "#2e5d27" }}>{savedMsg}</span>}
      </div>

      {yamlAes.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#33404d", marginBottom: 4 }}>
            {t("settings.remoteAe.yaml")}
          </div>
          {yamlAes.map((a) => (
            <div key={a.aeTitle} style={{ fontSize: 12, color: "#6b7785" }}>
              {a.aeTitle} — {a.host}:{a.port}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const headerRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12, color: "#5a6672" };
const dataRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 };
const cell: React.CSSProperties = { fontSize: 12 };
const input: React.CSSProperties = { minWidth: 0, padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const smallBtn: React.CSSProperties = {
  minWidth: 34, padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 13,
};
const addBtn: React.CSSProperties = {
  marginTop: 4, padding: "5px 12px", border: "1px dashed #b7c2cd", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, color: "#33404d",
};
const saveBtn: React.CSSProperties = { padding: "6px 16px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13 };
