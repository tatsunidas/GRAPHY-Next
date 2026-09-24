/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 患者画像を外部 AI へ送る前の同意ダイアログ（fw/art-of-imaging-design.md §3）。
 *
 * <p>**これから送る画像そのもの**と**プロンプト全文**を見せる。要約や件数では足りない。
 * 同意の対象は「AI を使うこと」ではなく「この画素とこの文字列が、この宛先へ出ること」だから。
 *
 * <p>抑止は「同一シリーズ・同一セッション内」までしか許さない。全面的な無効化を用意すると、
 * 一度押したきり誰も中身を見なくなる。宛先・プラグイン・画像が変われば必ず出し直す。
 *
 * <p>`window.confirm` を使わない理由は `PluginSaveConfirmDialog.tsx` と同じ
 * （Electron のネイティブダイアログがレンダラのキーボードフォーカスを奪う。特に Linux/GTK）。
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";

export interface AiEgressRequest {
  pluginId: string;
  pluginName: string;
  /** 送信先ホスト名（例 generativelanguage.googleapis.com）。 */
  host: string;
  model: string;
  /** 送信するプロンプト全文。省略・折り返しはするが、**切り詰めない**。 */
  prompt: string;
  /** 送信画像のプレビュー（data URL）。実際に送るバイト列から作ること。 */
  imageDataUrl: string;
  imageBytes: number;
}

export function AiEgressConsentDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: AiEgressRequest;
  /** `remember=true` なら同一シリーズ・同一セッション内は次回から確認を省く。 */
  onConfirm: (remember: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  // 🔴 チェックを入れるまで送信ボタンを押せない。読まずに通せる同意は同意ではない。
  const [ack, setAck] = useState(false);
  const [remember, setRemember] = useState(false);

  return createPortal(
    <div style={backdrop} data-testid="ai-egress-consent">
      <div style={panel}>
        <div style={title}>{t("ai.egress.title")}</div>
        <div style={body}>
          <p style={lead}>{t("ai.egress.lead", { plugin: request.pluginName, host: request.host })}</p>

          {/* 送るものを、送る形のまま見せる。 */}
          <div style={previewRow}>
            <img src={request.imageDataUrl} alt="" style={previewImg} data-testid="ai-egress-image" />
            <table style={table}>
              <tbody>
                <tr>
                  <th style={th}>{t("ai.egress.destination")}</th>
                  <td style={td} data-testid="ai-egress-host">{request.host}</td>
                </tr>
                <tr>
                  <th style={th}>{t("ai.egress.model")}</th>
                  <td style={td}>{request.model}</td>
                </tr>
                <tr>
                  <th style={th}>{t("ai.egress.plugin")}</th>
                  <td style={td}>{`${request.pluginName} (${request.pluginId})`}</td>
                </tr>
                <tr>
                  <th style={th}>{t("ai.egress.size")}</th>
                  <td style={td}>{`${Math.ceil(request.imageBytes / 1024)} KB`}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={promptLabel}>{t("ai.egress.prompt")}</div>
          <pre style={promptBox} data-testid="ai-egress-prompt">{request.prompt}</pre>

          {/* 🔴 焼き込み注記は既存の PNG 書き出し警告と同じ趣旨。外部送信はそれより強い行為。 */}
          <p style={notice}>{t("ai.egress.burnedIn")}</p>
          <p style={notice}>{t("ai.egress.freeTier")}</p>

          <label style={check}>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              data-testid="ai-egress-ack"
            />
            <span>{t("ai.egress.ack")}</span>
          </label>
          <label style={check}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              data-testid="ai-egress-remember"
            />
            <span>{t("ai.egress.remember")}</span>
          </label>
        </div>
        <div style={buttons}>
          <button style={btn} onClick={onCancel} data-testid="ai-egress-cancel">
            {t("common.cancel")}
          </button>
          <button
            style={{ ...btn, ...(ack ? primary : disabled) }}
            disabled={!ack}
            onClick={() => onConfirm(remember)}
            data-testid="ai-egress-send"
          >
            {t("ai.egress.send")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // プラグイン UI より確実に上（プラグインは任意の z-index を使える）。
  zIndex: 2147483000,
};
const panel: React.CSSProperties = {
  width: 620,
  maxWidth: "94vw",
  maxHeight: "90vh",
  display: "flex",
  flexDirection: "column",
  background: "#fff",
  borderRadius: 6,
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
  overflow: "hidden",
};
const title: React.CSSProperties = {
  padding: "10px 16px",
  background: "#8a4b00",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
};
const body: React.CSSProperties = {
  padding: "14px 16px",
  fontSize: 12,
  color: "#22303d",
  overflowY: "auto",
  // flex の子で overflow を効かせるための定石（この repo で何度も踏んでいる罠）。
  minHeight: 0,
};
const lead: React.CSSProperties = { margin: "0 0 10px" };
const previewRow: React.CSSProperties = { display: "flex", gap: 12, alignItems: "flex-start" };
const previewImg: React.CSSProperties = {
  width: 140,
  height: 140,
  objectFit: "contain",
  background: "#000",
  border: "1px solid #b9c6d4",
  flex: "0 0 auto",
};
const table: React.CSSProperties = { flex: 1, minWidth: 0, borderCollapse: "collapse", fontSize: 12 };
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 8px 4px 0",
  color: "#5a6b7d",
  fontWeight: 400,
  whiteSpace: "nowrap",
  verticalAlign: "top",
};
const td: React.CSSProperties = { padding: "4px 0", wordBreak: "break-all" };
const promptLabel: React.CSSProperties = { margin: "12px 0 4px", color: "#5a6b7d" };
const promptBox: React.CSSProperties = {
  margin: 0,
  padding: 8,
  maxHeight: 160,
  overflowY: "auto",
  background: "#f4f7fa",
  border: "1px solid #dfe6ee",
  borderRadius: 4,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
const notice: React.CSSProperties = { margin: "10px 0 0", color: "#8a4b00" };
const check: React.CSSProperties = { display: "flex", gap: 6, alignItems: "flex-start", margin: "10px 0 0" };
const buttons: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "10px 16px",
  borderTop: "1px solid #dfe6ee",
};
const btn: React.CSSProperties = {
  padding: "5px 14px",
  fontSize: 12,
  border: "1px solid #b9c6d4",
  borderRadius: 4,
  background: "#f4f7fa",
  cursor: "pointer",
};
const primary: React.CSSProperties = { background: "#8a4b00", borderColor: "#8a4b00", color: "#fff" };
const disabled: React.CSSProperties = { opacity: 0.5, cursor: "not-allowed" };
