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
  inspectPluginFromFile,
  inspectPluginFromGitHub,
  installPluginFromGitHub,
  reinstallPlugin,
  setPluginInstallEnabled,
  uninstallPlugin,
  type InstalledPlugin,
  type ManagerStatus,
  type PluginPreview,
} from "../plugins/pluginManagerApi";
import { PluginConsentDialog } from "./PluginConsentDialog";
import { markRestartRequired } from "../restartRequiredEvents";

/**
 * 環境設定の「プラグイン」カスタムパネル。
 *
 * <p>導入済みプラグインの一覧・有効無効・再インストール・削除と、GitHub（owner/repo）/ローカル zip
 * からの導入を行う（backend の {@code /api/plugin-manager/*}）。
 *
 * <p>導入系は standalone かつ管理者ゲート（{@code graphy.plugins.manager-enabled}）が開いており、
 * さらにユーザーが「プラグインの導入を許可する」トグルを ON にしたときだけ有効
 * （それ以外は閲覧のみ・backend が 403）。プラグインはアプリと同じ権限で動き署名検証は未実装のため、
 * 既定は OFF でトグルに警告を添える。反映（メニューへの反映）にはアプリのリロード/再起動が要る点も明示する。
 * 設計: fw/plugin-manager-design.md §5。
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
  /** 検査済みで、ユーザーの同意待ちになっている配布物（同意画面の入力）。 */
  const [pending, setPending] = useState<{ preview: PluginPreview; file?: File } | null>(null);

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
  const canOptIn = status?.canOptIn ?? false;
  const optedIn = status?.installEnabled ?? false;

  /** 導入オプトインの切替。保存後に status を取り直して canManage を反映する。 */
  const toggleOptIn = async () => {
    const next = !optedIn;
    setBusy("optin");
    setMsg(null);
    try {
      await setPluginInstallEnabled(next);
      setStatus(await fetchManagerStatus());
      setMsg({ text: t(next ? "pluginmgr.optIn.enabled" : "pluginmgr.optIn.disabled"), ok: true });
    } catch (e) {
      setMsg({ text: t("common.fetchError", { error: String(e) }), ok: false });
    } finally {
      setBusy(null);
    }
  };

  /** @returns 成功したか（同意画面を閉じてよいかの判断に使う）。 */
  const run = async (key: string, action: () => Promise<unknown>, okKey: string): Promise<boolean> => {
    setBusy(key);
    setMsg(null);
    try {
      await action();
      await reloadList();
      setMsg({ text: t(okKey), ok: true });
      return true;
    } catch (e) {
      setMsg({ text: t("common.fetchError", { error: String(e) }), ok: false });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const repoValid = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo.trim());

  /**
     導入は 2 段階。まず取得して中身を検査（展開しない）し、同意画面で対応 OS・同梱 JAR・
     完全性を提示する。ユーザーが承諾したら、検査時の sha256 を添えて導入する
     （同意した成果物と実際に入るものが一致することを backend が保証する）。
   */
  const inspect = async (key: string, action: () => Promise<PluginPreview>, file?: File) => {
    setBusy(key);
    setMsg(null);
    try {
      const preview = await action();
      // 既知の鍵で署名が検証できたものは、中身を見せるまでもなくそのまま導入する
      // （公式配布と 2 回目以降の更新は「押すだけ」）。それ以外は同意画面へ。
      if (preview.autoInstallable) {
        await installConfirmed(preview, file, false);
      } else {
        setPending({ preview, file });
      }
    } catch (e) {
      setMsg({ text: t("common.fetchError", { error: String(e) }), ok: false });
    } finally {
      setBusy(null);
    }
  };

  /**
   * JAR を含むプラグインは backend のクラスローダが id 単位でキャッシュされるため、
   * 導入/更新/削除/有効無効の反映にアプリ再起動が要る。全ウィンドウに再起動バナーを出す。
   * UI のみのプラグインは画面リロードで足りるので出さない（`pluginmgr.reloadNote` で案内）。
   */
  const markRestartIfJar = (jars: string[] | null | undefined) => {
    if (jars && jars.length > 0) markRestartRequired("plugin");
  };

  const installConfirmed = async (preview: PluginPreview, file: File | undefined, acknowledgeUnverified: boolean) => {
    const ok = await run(
      "confirm",
      () =>
        file
          ? installPluginFromFile(file, preview.sha256)
          : installPluginFromGitHub(repo.trim(), version.trim() || undefined, preview.sha256, acknowledgeUnverified),
      "pluginmgr.installed_result",
    );
    if (ok) markRestartIfJar(preview.jars);
    return ok;
  };

  const installGithub = () => {
    if (!repoValid) return;
    void inspect("github", () => inspectPluginFromGitHub(repo.trim(), version.trim() || undefined));
  };

  const installFile = (file: File | undefined) => {
    if (!file) return;
    void inspect("file", () => inspectPluginFromFile(file), file);
  };

  /** 同意画面で「導入する」を押したときだけ、実際に展開・保存する。失敗時は画面を閉じない。 */
  const confirmInstall = async (acknowledgeUnverified: boolean) => {
    if (!pending) return;
    if (await installConfirmed(pending.preview, pending.file, acknowledgeUnverified)) setPending(null);
  };

  const toggleEnabled = (p: InstalledPlugin) =>
    void run(p.id, () => (p.enabled ? disablePlugin(p.id) : enablePlugin(p.id)), "pluginmgr.updated")
      .then((ok) => ok && markRestartIfJar(p.jars));

  const doReinstall = (p: InstalledPlugin) =>
    void run(p.id, () => reinstallPlugin(p.id), "pluginmgr.installed_result")
      .then((ok) => ok && markRestartIfJar(p.jars));

  const doUninstall = (p: InstalledPlugin) => {
    if (!window.confirm(t("pluginmgr.confirmUninstall", { name: p.name || p.id }))) return;
    void run(p.id, () => uninstallPlugin(p.id), "pluginmgr.removed")
      .then((ok) => ok && markRestartIfJar(p.jars));
  };

  if (!loaded) return <div style={{ color: "#888" }}>{t("common.loading")}</div>;

  return (
    <div>
      <p style={{ fontSize: 13, color: "#6b7785", marginTop: 0 }}>{t("pluginmgr.help")}</p>

      {/* 導入オプトイン（standalone かつ管理者ゲートが開いているときだけ操作できる）。 */}
      {canOptIn ? (
        <section style={optInBox}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: busy ? "default" : "pointer" }}>
            <input
              type="checkbox"
              checked={optedIn}
              disabled={busy !== null}
              onChange={() => void toggleOptIn()}
            />
            <span style={{ fontSize: 13, fontWeight: 600, color: "#33404d" }}>{t("pluginmgr.optIn.label")}</span>
          </label>
          <p style={{ fontSize: 12, color: "#6b5a00", margin: "6px 0 0 24px" }}>⚠ {t("pluginmgr.optIn.warning")}</p>
        </section>
      ) : (
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
              {busy === "github" ? t("pluginmgr.inspecting") : t("pluginmgr.installGithub")}
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ ...secondaryBtn, opacity: busy !== null ? 0.6 : 1 }}>
              {busy === "file" ? t("pluginmgr.inspecting") : t("pluginmgr.installFile")}
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
      {canOptIn && !optedIn && (
        <div style={{ fontSize: 12, color: "#6b7785", marginBottom: 6 }}>{t("pluginmgr.optIn.viewOnly")}</div>
      )}
      {rows.length === 0 ? (
        <div style={{ color: "#888", fontSize: 13, padding: "6px 0" }}>{t("pluginmgr.empty")}</div>
      ) : (
        <>
          {/*
            設定パネルは幅が狭く、名前・版・取得元・信頼・操作ボタンを 1 行に並べると
            名前が真っ先に省略されて読めなくなる（実機で確認）。名前を独立行に上げ、
            版/取得元/信頼は副行のメタ情報として折り返す 2 段構成にする。
          */}
          {rows.map((p) => (
            <div key={p.id} style={{ ...dataRow, opacity: p.enabled ? 1 : 0.55 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={nameLine} title={`${p.name || p.id}（${p.id}）`}>
                  {p.name || p.id}
                  {!p.enabled && (
                    <span style={{ color: "#b00020", marginLeft: 6, fontWeight: 400 }}>
                      ({t("pluginmgr.disabled")})
                    </span>
                  )}
                </div>
                <div style={metaLine}>
                  <span title={t("pluginmgr.col.version")}>{p.version}</span>
                  <span style={metaSep}>·</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
                    title={`${t("pluginmgr.col.source")}: ${p.source ? `${p.source.type}: ${p.source.ref}` : "—"}`}>
                    {p.source ? `${p.source.type}: ${p.source.ref}` : "—"}
                  </span>
                  <span style={metaSep}>·</span>
                  <span style={{ color: trustColor(p.trust), flex: "none" }} title={t("pluginmgr.col.trust")}>
                    {p.trust}
                  </span>
                </div>
              </div>
              {canManage && (
                <div style={{ flex: "none", display: "flex", gap: 6, justifyContent: "flex-end" }}>
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

      {/* 検査済み・同意待ち。ここで承諾しない限り展開も保存もされない。 */}
      {pending && (
        <PluginConsentDialog
          preview={pending.preview}
          busy={busy === "confirm"}
          onCancel={() => setPending(null)}
          onConfirm={(ack) => void confirmInstall(ack)}
        />
      )}
    </div>
  );
}

function trustColor(trust: string): string {
  if (trust === "verified") return "#2e7d32";
  if (trust === "local") return "#8a6d00";
  return "#33404d"; // community
}

const optInBox: React.CSSProperties = {
  border: "1px solid #e2e7ee", borderRadius: 6, padding: "10px 12px", marginBottom: 14, background: "#fbfcfe",
};
const notice: React.CSSProperties = {
  fontSize: 12, color: "#6b5a00", background: "#fff8e1", border: "1px solid #f0e2a8",
  borderRadius: 6, padding: "8px 10px", marginBottom: 14,
};
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#33404d", margin: "0 0 8px" };
const dataRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13, borderTop: "1px solid #eef1f5",
};
/** 名前は省略させない（長い名前は折り返す）。行が伸びても読めることを優先する。 */
const nameLine: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, color: "#33404d", overflowWrap: "anywhere", lineHeight: 1.35,
};
const metaLine: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5, marginTop: 2, fontSize: 11, color: "#6b7785", minWidth: 0,
};
const metaSep: React.CSSProperties = { color: "#c2cad3", flex: "none" };
const input: React.CSSProperties = { minWidth: 0, padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 5, fontSize: 13 };
const smallBtn: React.CSSProperties = {
  minWidth: 30, padding: "4px 8px", border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12,
};
const primaryBtn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13, cursor: "pointer" };
const secondaryBtn: React.CSSProperties = {
  padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13, color: "#33404d",
};
