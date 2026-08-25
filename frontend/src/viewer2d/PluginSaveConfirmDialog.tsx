/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインが派生シリーズを保存する前の確認ダイアログ（fw/plugin-architecture.md §7 の H4b）。
 *
 * <p>**抑止不可**（「次回から表示しない」を用意しない）。プラグインの出力が診療データとして
 * 保管庫 / PACS に入る操作なので、誰の何がどこへ書かれるのかを毎回提示して同意を取る。
 *
 * <p>`window.confirm` を使わない理由: Electron のネイティブダイアログはレンダラのキーボード
 * フォーカスを奪う既知の問題があり（特に Linux/GTK）、自動検証からも操作できない。
 */
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";

export interface PluginSaveRequest {
  pluginName: string;
  pluginVersion: string;
  seriesDescription: string;
  instanceCount: number;
  /** 保存先（web は外部 PACS へ STOW-RS、standalone はローカル保管庫）。 */
  mode: "standalone" | "web";
  /**
   * 何を保存するか。**画像シリーズと計測レポート（SR）では中身が違う**ので、
   * 「何がどこへ書かれるのか」を正しく提示するために分ける。
   */
  kind?: "series" | "sr" | "angio-sr" | "angio-ps";
  /** SR のとき: 計測グループ（病変）数と所見テキスト数。 */
  groupCount?: number;
  findingCount?: number;
  /**
   * アンギオ解析 SR のとき: どの解析か（`qca` / `qva` / `qlv` / `qca3d`）。
   * **何を保存するのかを「計測 N 件」ではなく解析の名前で見せる**——同意する側にとって
   * 意味があるのは件数ではなく「QCA の結果が保管庫に入る」という事実のほうなので。
   */
  analysisKind?: "qca" | "qva" | "qlv" | "qca3d";
}

/** 解析の呼び方は解析タスク一覧（A13-2）と同じ文言を使う。**画面ごとに変えない**。 */
const ANALYSIS_LABEL = {
  qca: "xa.task.qca",
  qva: "xa.task.qva",
  qlv: "xa.task.qlv",
  qca3d: "xa.task.qca3d",
} as const;

export function PluginSaveConfirmDialog({
  request,
  onConfirm,
  onCancel,
}: {
  request: PluginSaveRequest;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const isAngio = request.kind === "angio-sr";
  // 表示状態（GSPS）は「計測」ではないので SR 用の文言に寄せない。
  const isPs = request.kind === "angio-ps";
  const isSr = request.kind === "sr" || isAngio;
  // **document.body へ出し、最上位に置く。** プラグインの UI は本体の DOM とは別に
  // body へ挿し込まれ、任意の z-index を持てる。同じツリー内で z-index を競わせると
  // スタッキングコンテキスト次第で負ける（実機で SR 保存の同意ダイアログが
  // プラグインのパネルに隠れた）。同意を求める画面が読めないのは同意の意味を損なう。
  const key = (name: string): string => `viewer2d.plugin.${isPs ? "ps" : isSr ? "sr" : "save"}.${name}`;
  return createPortal(
    <div style={backdrop} data-testid="plugin-save-confirm">
      <div style={panel}>
        <div style={title}>{t(key("title"))}</div>
        <div style={body}>
          <p style={lead}>
            {t(key("lead"), { name: request.pluginName, version: request.pluginVersion })}
          </p>
          <table style={table}>
            <tbody>
              <tr>
                <th style={th}>{t(key("seriesDescription"))}</th>
                {/* 保存時に本体が付ける接頭辞をそのまま見せる（一覧での見え方と一致させる）。 */}
                <td style={td} data-testid="plugin-save-description">{`[Plugin] ${request.seriesDescription}`}</td>
              </tr>
              {isPs ? (
                <tr>
                  <th style={th}>{t("viewer2d.plugin.ps.contains")}</th>
                  <td style={td} data-testid="plugin-save-ps">{t("viewer2d.plugin.ps.containsValue")}</td>
                </tr>
              ) : isAngio ? (
                <tr>
                  <th style={th}>{t("viewer2d.plugin.sr.analysis")}</th>
                  <td style={td} data-testid="plugin-save-analysis">
                    {t(ANALYSIS_LABEL[request.analysisKind ?? "qca"])}
                  </td>
                </tr>
              ) : isSr ? (
                <>
                  <tr>
                    <th style={th}>{t("viewer2d.plugin.sr.groups")}</th>
                    <td style={td} data-testid="plugin-save-groups">{request.groupCount ?? 0}</td>
                  </tr>
                  <tr>
                    <th style={th}>{t("viewer2d.plugin.sr.findings")}</th>
                    <td style={td} data-testid="plugin-save-findings">{request.findingCount ?? 0}</td>
                  </tr>
                </>
              ) : (
                <tr>
                  <th style={th}>{t("viewer2d.plugin.save.instances")}</th>
                  <td style={td}>{request.instanceCount}</td>
                </tr>
              )}
              <tr>
                <th style={th}>{t("viewer2d.plugin.save.destination")}</th>
                <td style={td}>
                  {request.mode === "web"
                    ? t("viewer2d.plugin.save.destination.web")
                    : t("viewer2d.plugin.save.destination.standalone")}
                </td>
              </tr>
            </tbody>
          </table>
          <p style={notice}>{t(key("notice"))}</p>
        </div>
        <div style={buttons}>
          <button style={btn} onClick={onCancel} data-testid="plugin-save-cancel">
            {t("common.cancel")}
          </button>
          <button style={{ ...btn, ...primary }} onClick={onConfirm} data-testid="plugin-save-confirm-button">
            {t("viewer2d.plugin.save.confirm")}
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
  width: 520,
  maxWidth: "92vw",
  background: "#fff",
  borderRadius: 6,
  boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
  overflow: "hidden",
};
const title: React.CSSProperties = {
  padding: "10px 16px",
  background: "#0b5cad",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
};
const body: React.CSSProperties = { padding: "14px 16px", fontSize: 12, color: "#22303d" };
const lead: React.CSSProperties = { margin: "0 0 10px" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const th: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 8px 4px 0",
  color: "#5a6b7d",
  fontWeight: 400,
  whiteSpace: "nowrap",
  verticalAlign: "top",
};
const td: React.CSSProperties = { padding: "4px 0", wordBreak: "break-all" };
const notice: React.CSSProperties = { margin: "12px 0 0", color: "#8a4b00" };
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
const primary: React.CSSProperties = { background: "#0b5cad", borderColor: "#0b5cad", color: "#fff" };
