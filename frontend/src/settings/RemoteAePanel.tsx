/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { echoDicom, fetchRemoteAes, scanNetworkDevices, type RemoteAe } from "../api";
import { addDiscovered, groupDiscovered, toRow, type DiscoveredItem } from "./discoveryView";
import { fetchSettings, saveSettings } from "./settingsApi";
import { emitRemoteAesChanged } from "../remoteAeEvents";
import { DicomTlsSection } from "./DicomTlsSection";
import { ReceiveAnonymizePanel } from "./ReceiveAnonymizePanel";
import { useI18n } from "../i18n/i18n";

/** Settings(H2) にリモート DICOM ノードを JSON 配列で保存するキー。backend の REMOTE_AES_KEY と一致。 */
const REMOTE_AES_KEY = "dicom.remoteAes";

type Row = { aeTitle: string; host: string; port: string; tls: boolean };
type EchoState = "idle" | "running" | "ok" | "fail";

/**
 * 環境設定の「DICOM 通信ノード」カスタムパネル。
 *
 * <p>GUI からリモート DICOM ノード（AE タイトル / ホスト / ポート / TLS）を追加・編集・削除し、
 * Settings(H2) に保存する。ここで登録したノードは <b>DICOM Send（C-STORE）の送信先</b>と
 * <b>Query/Retrieve（C-FIND/C-MOVE）の接続先</b>の<b>両方</b>で共通に使われる。保存分は backend で
 * application.yml の {@code remote-aes} とマージされる。行ごとに C-ECHO 疎通確認ができる。
 * TLS を有効にしたノードへは鍵材料（グローバル TLS 設定）を用いて DIMSE TLS で接続する。
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
  // 「ネットワークで探す」: null＝まだ探していない。探した結果が空なら空配列（「見つかりませんでした」を出す）。
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredItem[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pickedHost, setPickedHost] = useState<Record<number, string>>({});

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
        setRows(stored.map((a) => ({
          aeTitle: a.aeTitle ?? "", host: a.host ?? "", port: String(a.port ?? ""), tls: !!a.tls,
        })));
        // マージ結果のうち Settings に無い＝YAML 由来（読み取り専用で参考表示）。
        setYamlAes(merged.filter((a) => !storedAets.has(a.aeTitle)));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (i: number, key: "aeTitle" | "host" | "port", val: string) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
    setDirty(true);
    setSavedMsg(null);
    setEcho((e) => ({ ...e, [i]: "idle" }));
  };

  const updateTls = (i: number, tls: boolean) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, tls } : r)));
    setDirty(true);
    setSavedMsg(null);
    setEcho((e) => ({ ...e, [i]: "idle" }));
  };

  const addRow = () => {
    setRows((rs) => [...rs, { aeTitle: "", host: "", port: "104", tls: false }]);
    setDirty(true);
    setSavedMsg(null);
  };

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    setPickedHost({});
    try {
      setFound(groupDiscovered(await scanNetworkDevices()));
    } catch (e) {
      setFound(null);
      setScanError(t("settings.remoteAe.discover.error", { error: String(e) }));
    } finally {
      setScanning(false);
    }
  };

  // 利用者が［追加］を押したときだけ行に入れる（自動では入れない・保存もしない）。同じ AE タイトルは確認してから上書き。
  const addFound = (i: number, item: DiscoveredItem) => {
    const host = pickedHost[i] ?? item.hosts[0];
    const r = addDiscovered(rows, item, host, (aeTitle) =>
      window.confirm(t("settings.remoteAe.discover.overwrite", { aeTitle })));
    if (!r.changed) return;
    setRows(r.rows);
    setEcho({});
    setDirty(true);
    setSavedMsg(t("settings.remoteAe.discover.addedHint"));
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
      .map((r) => ({ aeTitle: r.aeTitle.trim(), host: r.host.trim(), port: Number(r.port), tls: r.tls }));
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
      const res = await echoDicom({ host: r.host.trim(), port: Number(r.port), calledAet: r.aeTitle.trim(), tls: r.tls });
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
        <span style={{ ...cell, width: 44, flex: "none", textAlign: "center" }}>{t("send.tls")}</span>
        <span style={{ width: 100, flex: "none" }} />
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
          <div style={{ width: 44, flex: "none", display: "flex", justifyContent: "center" }}>
            <input type="checkbox" checked={r.tls} title={t("send.tls")}
              onChange={(e) => updateTls(i, e.target.checked)} />
          </div>
          <div style={{ width: 100, flex: "none", display: "flex", gap: 6, justifyContent: "flex-end" }}>
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

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={addRow} style={addBtn}>＋ {t("common.add")}</button>
        <button onClick={() => void scan()} disabled={scanning} style={addBtn}>
          {scanning ? t("settings.remoteAe.discover.scanning") : `🔎 ${t("settings.remoteAe.discover")}`}
        </button>
      </div>

      {scanError && <div style={{ marginTop: 8, fontSize: 12, color: "#b00020" }}>{scanError}</div>}
      {found !== null && !scanning && (
        <div style={foundBox}>
          {found.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6b7785" }}>{t("settings.remoteAe.discover.none")}</div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#33404d", marginBottom: 4 }}>
                {t("settings.remoteAe.discover.found", { count: found.length })}
              </div>
              {found.map((item, i) => {
                const row = toRow(item, pickedHost[i] ?? item.hosts[0]);
                return (
                  <div key={`${item.aeTitle}:${item.port}:${item.tlsPort}`} style={foundRow}>
                    <span style={{ flex: 2, fontWeight: 600 }}>{item.aeTitle}</span>
                    {item.hosts.length > 1 ? (
                      <select style={{ ...input, flex: 3 }} value={pickedHost[i] ?? item.hosts[0]}
                        onChange={(e) => setPickedHost((p) => ({ ...p, [i]: e.target.value }))}>
                        {item.hosts.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    ) : (
                      <span style={{ flex: 3 }}>{item.hosts[0]}</span>
                    )}
                    <span style={{ width: 70, flex: "none" }}>{row.port}</span>
                    <span style={{ width: 44, flex: "none", textAlign: "center" }}>{row.tls ? t("send.tls") : ""}</span>
                    <button style={smallBtn} onClick={() => addFound(i, item)}>{t("common.add")}</button>
                    {item.aeTitleFromName && (
                      <span style={{ width: "100%", fontSize: 11, color: "#8a6d00" }}>{t("settings.remoteAe.discover.fromName")}</span>
                    )}
                  </div>
                );
              })}
            </>
          )}
          <div style={{ marginTop: 6, fontSize: 11, color: "#8a6d00" }}>ⓘ {t("settings.remoteAe.discover.warn")}</div>
        </div>
      )}

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

      <DicomTlsSection />

      <ReceiveAnonymizePanel />

      {yamlAes.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#33404d", marginBottom: 4 }}>
            {t("settings.remoteAe.yaml")}
          </div>
          {yamlAes.map((a) => (
            <div key={a.aeTitle} style={{ fontSize: 12, color: "#6b7785" }}>
              {a.aeTitle} — {a.host}:{a.port}{a.tls ? " · TLS" : ""}
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
const foundBox: React.CSSProperties = { marginTop: 10, padding: "8px 10px", border: "1px solid #dfe5ec", borderRadius: 6, background: "#f8fafc" };
const foundRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4, fontSize: 13 };
const saveBtn: React.CSSProperties = { padding: "6px 16px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13 };
