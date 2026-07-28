/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { PluginPreview } from "../plugins/pluginManagerApi";

/**
 * プラグイン導入前の同意画面。
 *
 * <p>取得はしたがまだ展開していない zip の中身（同梱 JAR の有無・宣言権限・対応 OS・完全性）を
 * 提示し、ユーザーが承諾したときだけ導入する。プラグインはアプリと同じ権限で動き、署名検証も
 * 未実装なので、「何を受け入れるのか」をここで明示するのが唯一の防御線になる。
 *
 * <p>対応 OS（{@code engines.os}）とコア版数（{@code engines.graphy}）が合わない場合は
 * 同意しても導入できない（backend も fail-closed で再検証する）。
 * 設計: fw/plugin-manager-design.md §5。
 */
export function PluginConsentDialog({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: PluginPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (acknowledgeUnverified: boolean) => void;
}) {
  const { t } = useI18n();
  const [ackUnverified, setAckUnverified] = useState(false);

  const needsAck = !preview.integrityVerified;
  const canConfirm = preview.installable && (!needsAck || ackUnverified) && !busy;

  return (
    <div style={backdrop} role="dialog" aria-modal="true">
      <div style={sheet}>
        <h3 style={title}>{t("pluginmgr.consent.title")}</h3>

        <div style={identity}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#33404d", overflowWrap: "anywhere" }}>
            {preview.name || preview.id}
          </div>
          <div style={{ fontSize: 12, color: "#6b7785", marginTop: 2, overflowWrap: "anywhere" }}>
            {preview.id} · {preview.version} · {preview.sourceType}: {preview.sourceRef}
          </div>
          {preview.description && (
            <div style={{ fontSize: 12, color: "#5a6672", marginTop: 6 }}>{preview.description}</div>
          )}
          <div style={{ fontSize: 11, color: "#8a94a0", marginTop: 4 }}>
            {[preview.author, preview.license].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>

        {/* 署名。既知の鍵で通った場合はそもそもこの画面が出ない（押すだけで入る）。 */}
        <Row
          ok={preview.signature !== "unsigned" && preview.signature !== "invalid"}
          label={t("pluginmgr.consent.signature")}
          value={signatureText(preview, t)}
        />

        {/* 突き合わせ結果（OS / コア版数）。NG なら同意しても導入させない。 */}
        <Row
          ok={preview.osOk}
          label={t("pluginmgr.consent.os")}
          value={
            preview.declaredOs.length === 0
              ? t("pluginmgr.consent.osAny", { current: preview.currentOs })
              : t("pluginmgr.consent.osList", {
                  declared: preview.declaredOs.join(", "),
                  current: preview.currentOs,
                })
          }
        />
        <Row
          ok={preview.graphyOk}
          label={t("pluginmgr.consent.core")}
          value={t("pluginmgr.consent.coreValue", {
            range: preview.graphyRange || "*",
            core: preview.coreVersion,
          })}
        />
        <Row
          ok={preview.integrityVerified}
          label={t("pluginmgr.consent.integrity")}
          value={
            preview.integrityVerified
              ? t("pluginmgr.consent.integrityOk")
              : t("pluginmgr.consent.integrityUnverified")
          }
        />

        {/* 中身。JAR の有無は「アプリと同じ権限で動くコード」の有無を意味する。 */}
        <div style={block}>
          <div style={blockTitle}>{t("pluginmgr.consent.contents")}</div>
          <div style={{ fontSize: 12, color: "#5a6672" }}>
            {t("pluginmgr.consent.fileCount", {
              count: String(preview.files.length),
              size: formatBytes(preview.totalBytes),
            })}
          </div>
          {preview.hasUi && <div style={{ fontSize: 12, color: "#5a6672" }}>· ui.js（{t("pluginmgr.consent.uiScope")}）</div>}
          {preview.jars.length > 0 && (
            <div style={danger}>⚠ {t("pluginmgr.consent.jarWarning", { jars: preview.jars.join(", ") })}</div>
          )}
          {preview.permissions.length > 0 && (
            <div style={{ fontSize: 12, color: "#6b5a00", marginTop: 4 }}>
              {t("pluginmgr.consent.permissions", { list: preview.permissions.join(", ") })}
            </div>
          )}
        </div>

        {preview.signature === "unsigned" && <div style={notice}>⚠ {t("pluginmgr.consent.noSignature")}</div>}
        {preview.signature === "first-use" && <div style={notice}>⚠ {t("pluginmgr.consent.firstUseKey")}</div>}

        {preview.alreadyInstalled && (
          <div style={notice}>⚠ {t("pluginmgr.consent.overwrite")}</div>
        )}

        {!preview.installable && (
          <div style={blocked}>{t("pluginmgr.consent.blocked")}</div>
        )}

        {preview.installable && needsAck && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, fontSize: 12 }}>
            <input type="checkbox" checked={ackUnverified} onChange={(e) => setAckUnverified(e.target.checked)} />
            <span style={{ color: "#6b5a00" }}>{t("pluginmgr.consent.ackUnverified")}</span>
          </label>
        )}

        <div style={{ fontSize: 10, color: "#8a94a0", marginTop: 10, overflowWrap: "anywhere" }}>
          sha256: {preview.sha256}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button style={secondaryBtn} onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            style={{ ...primaryBtn, background: canConfirm ? "#0b5cad" : "#9fb6cf" }}
            disabled={!canConfirm}
            onClick={() => onConfirm(ackUnverified)}
          >
            {busy ? t("pluginmgr.installing") : t("pluginmgr.consent.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 署名状態を 1 行の文言にする。鍵 ID は短縮して添える（同一性の目視確認用）。 */
function signatureText(p: PluginPreview, t: (k: string, v?: Record<string, string>) => string): string {
  const key = p.signerKeyId ? p.signerKeyId.slice(0, 8) : "—";
  switch (p.signature) {
    case "trusted":
      return t("pluginmgr.consent.sigTrusted", { key });
    case "pinned":
      return t("pluginmgr.consent.sigPinned", { key });
    case "first-use":
      return t("pluginmgr.consent.sigFirstUse", { key });
    case "invalid":
      return t("pluginmgr.consent.sigInvalid", { problem: p.signatureProblem || "" });
    default:
      return t("pluginmgr.consent.sigNone");
  }
}

function Row({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginTop: 8, fontSize: 12 }}>
      <span style={{ flex: "none", color: ok ? "#2e7d32" : "#b00020" }}>{ok ? "✓" : "✕"}</span>
      <span style={{ flex: "none", color: "#6b7785", minWidth: 76 }}>{label}</span>
      <span style={{ color: ok ? "#33404d" : "#b00020", overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16,
};
const sheet: React.CSSProperties = {
  background: "#fff", borderRadius: 8, padding: "16px 18px", width: 460, maxWidth: "100%",
  maxHeight: "80vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
};
const title: React.CSSProperties = { margin: "0 0 12px", fontSize: 15, color: "#33404d" };
const identity: React.CSSProperties = {
  border: "1px solid #e2e7ee", borderRadius: 6, padding: "10px 12px", background: "#fbfcfe",
};
const block: React.CSSProperties = { marginTop: 12 };
const blockTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#33404d", marginBottom: 4 };
const danger: React.CSSProperties = {
  fontSize: 12, color: "#b00020", background: "#fdecef", border: "1px solid #f5c2cb",
  borderRadius: 6, padding: "6px 8px", marginTop: 6,
};
const notice: React.CSSProperties = {
  fontSize: 12, color: "#6b5a00", background: "#fff8e1", border: "1px solid #f0e2a8",
  borderRadius: 6, padding: "6px 8px", marginTop: 10,
};
const blocked: React.CSSProperties = {
  fontSize: 12, color: "#b00020", background: "#fdecef", border: "1px solid #f5c2cb",
  borderRadius: 6, padding: "8px 10px", marginTop: 10, fontWeight: 600,
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 14px", border: "none", borderRadius: 6, color: "#fff", fontSize: 13, cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff",
  cursor: "pointer", fontSize: 13, color: "#33404d",
};
