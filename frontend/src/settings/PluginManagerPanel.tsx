/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import {
  disablePlugin,
  enablePlugin,
  fetchInstalledPlugins,
  fetchManagerStatus,
  installPluginFromFile,
  installPluginFromGitHub,
  reinstallPlugin,
  uninstallPlugin,
  type InstalledPlugin,
  type ManagerStatus,
} from "../plugins/pluginManagerApi";

/**
 * 環境設定の「プラグイン」カスタムパネル。
 *
 * <p>導入済みプラグインの一覧・有効無効・再インストール・削除と、GitHub（owner/repo）/ローカル zip
 * からの導入を行う（backend の {@code /api/plugin-manager/*}）。導入系は standalone かつ
 * {@code graphy.plugins.manager-enabled=true} のときのみ有効で、それ以外は閲覧のみ（backend が 403）。
 * 反映（メニューへの反映）にはアプリのリロード/再起動が要る点を明示する。設計: fw/plugin-manager-design.md。
 */
export function PluginManagerPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ManagerStatus | null>(null);
  const [rows, setRows] = useState<InstalledPlugin[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // 処理中の対象（id もしくは "github"/"file"）
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [repo, setRepo] = useState("");
  const [version, setVersion] = useState("");

  const reloadList = () => fetchInstalledPlugins().then(setRows);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchManagerStatus().catch(() => null),
      fetchInstalledPlugins().catch(() => [] as InstalledPlugin[]),
    ])
      .then(([st, list]) => {
        if (cancelled) return;
        setStatus(st);
        setRows(list);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const canManage = status?.canManage ?? false;

  const run = async (key: string, action: () => Promise<unknown>, okKey: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await action();
      await reloadList();
      setMsg({ text: t(okKey), ok: true });
    } catch (e) {
      setMsg({ text: t("common.fetchError", { error: String(e) }), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const repoValid = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo.trim());

  const installGithub = () => {
    if (!repoValid) return;
    void run(
      "github",
      () => installPluginFromGitHub(repo.trim(), version.trim() || undefined),
      "pluginmgr.installed_result",
    );
  };

  const installFile = (file: File | undefined) => {
    if (!file) return;
    void run("file", () => installPluginFromFile(file), "pluginmgr.installed_result");
  };

  const toggleEnabled = (p: InstalledPlugin) =>
    void run(p.id, () => (p.enabled ? disablePlugin(p.id) : enablePlugin(p.id)), "pluginmgr.updated");

  const doReinstall = (p: InstalledPlugin) =>
    void run(p.id, () => reinstallPlugin(p.id), "pluginmgr.installed_result");

  const doUninstall = (p: InstalledPlugin) => {
    if (!window.confirm(t("pluginmgr.confirmUninstall", { name: p.name || p.id }))) return;
    void run(p.id, () => uninstallPlugin(p.id), "pluginmgr.removed");
  };

  if (!loaded) return <div style={{ color: "#888" }}>{t("common.loading")}</div>;

  return (
    <div>
      <p style={{ fontSize: 13, color: "#6b7785", marginTop: 0 }}>{t("pluginmgr.help")}</p>

      {!canManage && (
        <div style={notice}>
          {status && !status.standalone
            ? t("pluginmgr.webDisabled")
            : t("pluginmgr.disabledHint")}
        </div>
      )}

      {/* 導入セクション（操作可能時のみ）。 */}
      {canManage && (
        <section style={{ marginBottom: 20 }}>
          <h3 style={sectionTitle}>{t("pluginmgr.install")}</h3>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input
              style={{ ...input, flex: 3, minWidth: 180 }}
              value={repo}
              placeholder="owner/repo"
              spellCheck={false}
              onChange={(e) => setRepo(e.target.value)}
            />
            <input
              style={{ ...input, width: 120, flex: "none" }}
              value={version}
              placeholder={t("pluginmgr.versionPlaceholder")}
              spellCheck={false}
              onChange={(e) => setVersion(e.target.value)}
            />
            <button
              onClick={installGithub}
              disabled={!repoValid || busy !== null}
              style={{ ...primaryBtn, background: !repoValid || busy !== null ? "#9fb6cf" : "#0b5cad" }}
            >
              {busy === "github" ? t("pluginmgr.installing") : t("pluginmgr.installGithub")}
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ ...secondaryBtn, opacity: busy !== null ? 0.6 : 1 }}>
              {busy === "file" ? t("pluginmgr.installing") : t("pluginmgr.installFile")}
              <input
                type="file"
                accept=".zip"
                style={{ display: "none" }}
                disabled={busy !== null}
                onChange={(e) => {
                  installFile(e.target.files?.[0]);
                  e.target.value = ""; // 同じファイルを選び直せるようにリセット
                }}
              />
            </label>
            <span style={{ fontSize: 12, color: "#6b7785" }}>{t("pluginmgr.installFileHint")}</span>
          </div>
        </section>
      )}

      {msg && (
        <div style={{ fontSize: 12, color: msg.ok ? "#2e5d27" : "#b00020", marginBottom: 10 }}>{msg.text}</div>
      )}

      {/* 導入済み一覧。 */}
      <h3 style={sectionTitle}>{t("pluginmgr.installed")}</h3>
      {rows.length === 0 ? (
        <div style={{ color: "#888", fontSize: 13, padding: "6px 0" }}>{t("pluginmgr.empty")}</div>
      ) : (
        <>
          <div style={headerRow}>
            <span style={{ ...cell, flex: 3 }}>{t("pluginmgr.col.name")}</span>
            <span style={{ ...cell, width: 70, flex: "none" }}>{t("pluginmgr.col.version")}</span>
            <span style={{ ...cell, flex: 2 }}>{t("pluginmgr.col.source")}</span>
            <span style={{ ...cell, width: 74, flex: "none" }}>{t("pluginmgr.col.trust")}</span>
            {canManage && <span style={{ width: 150, flex: "none" }} />}
          </div>
          {rows.map((p) => (
            <div key={p.id} style={{ ...dataRow, opacity: p.enabled ? 1 : 0.55 }}>
              <span style={{ ...cell, flex: 3 }} title={p.id}>
                {p.name || p.id}
                {!p.enabled && <span style={{ color: "#b00020", marginLeft: 6 }}>({t("pluginmgr.disabled")})</span>}
              </span>
              <span style={{ ...cell, width: 70, flex: "none" }}>{p.version}</span>
              <span style={{ ...cell, flex: 2, color: "#6b7785" }} title={p.source?.ref ?? ""}>
                {p.source ? `${p.source.type}: ${p.source.ref}` : "—"}
              </span>
              <span style={{ ...cell, width: 74, flex: "none", color: trustColor(p.trust) }}>{p.trust}</span>
              {canManage && (
                <div style={{ width: 150, flex: "none", display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button style={smallBtn} disabled={busy !== null} onClick={() => toggleEnabled(p)}
                    title={p.enabled ? t("pluginmgr.disable") : t("pluginmgr.enable")}>
                    {p.enabled ? t("pluginmgr.disable") : t("pluginmgr.enable")}
                  </button>
                  <button style={smallBtn} disabled={busy !== null} onClick={() => doReinstall(p)}
                    title={t("pluginmgr.reinstall")}>
                    ⟳
                  </button>
                  <button style={{ ...smallBtn, color: "#b00020" }} disabled={busy !== null}
                    onClick={() => doUninstall(p)} title={t("pluginmgr.uninstall")}>
                    ✕
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <p style={{ fontSize: 12, color: "#6b7785", marginTop: 16 }}>{t("pluginmgr.reloadNote")}</p>
    </div>
  );
}

function trustColor(trust: string): string {
  if (trust === "verified") return "#2e7d32";
  if (trust === "local") return "#8a6d00";
  return "#33404d"; // community
}

const notice: React.CSSProperties = {
  fontSize: 12, color: "#6b5a00", background: "#fff8e1", border: "1px solid #f0e2a8",
  borderRadius: 6, padding: "8px 10px", marginBottom: 14,
};
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#33404d", margin: "0 0 8px" };
const headerRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12, color: "#5a6672" };
const dataRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13 };
const cell: React.CSSProperties = { fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const input: React.CSSProperties = { minWidth: 0, padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const smallBtn: React.CSSProperties = {
  minWidth: 30, padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12,
};
const primaryBtn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13, cursor: "pointer" };
const secondaryBtn: React.CSSProperties = {
  padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, color: "#33404d",
};
