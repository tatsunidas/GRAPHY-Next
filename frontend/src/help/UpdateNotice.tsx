/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Help メニューの「更新を確認」／起動時チェックの UI。
//   - 新版あり → 現在→最新・リリースノートを表示。
//     ・自動更新できる環境（Windows・Linux の AppImage）: 「今すぐ更新」「終了時に更新」「後で」「このバージョンをスキップ」。
//       **ダウンロードは「今すぐ」「終了時」を押したときだけ始まる**（勝手に始めない）。取得・署名の確認・適用は main（desktop/appUpdate.js）。
//       途中でインターネットが切れたときは失敗として見送り、今の版のまま使える。
//     ・それ以外（Mac・deb など）: 今までどおり「ダウンロードページを開く」（通知のみ）。
//   - 手動確認では「最新版です」「確認できません」も表示。自動（起動時）は新版時のみ表示。
//
// App に <UpdateNoticeHost /> を 1 つだけマウントし、runUpdateCheck() を呼ぶだけでよい。

import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchStatus } from "../api";
import type { UpdateProgress } from "../desktopBridge";
import { openExternal } from "./links";
import {
  checkForUpdate, formatMegabytes, isSkipped, isUpdateActive, skipVersion, updateFailureKind, updateProgressPercent,
  type UpdateResult,
} from "./update";
import { cancelUpdate, getUpdateState, startUpdate, useUpdateState, wasUpdateStartedHere } from "./updateState";

/** 結果が分からないとき（進行中の画面を開き直すとき）の、ダウンロードページ。 */
const RELEASES_PAGE = "https://github.com/tatsunidas/GRAPHY-Next/releases/latest";

let showFn: ((r: UpdateResult | null, manual: boolean) => void) | null = null;

/**
 * 更新を確認し、必要なら通知ダイアログを開く。
 * @param manual 手動（Help メニュー）なら true。true のときは「最新/失敗」も表示し、スキップ設定は無視する。
 */
export async function runUpdateCheck(manual: boolean): Promise<void> {
  // 取得・検証・適用の最中、または「終了時に更新」の保留があるときは、確認し直さずにその状態を見せる
  const us = getUpdateState();
  if (isUpdateActive(us.phase) || us.phase === "ready") {
    if (manual) showFn?.(null, true);
    return;
  }
  let current = "";
  try {
    current = (await fetchStatus()).version;
  } catch {
    if (manual) showFn?.({ kind: "error" }, true);
    return;
  }
  const r = await checkForUpdate(current);
  if (r.kind === "update") {
    if (!manual && isSkipped(r.latest)) return; // 自動時はスキップ済みを尊重
    showFn?.(r, manual);
  } else if (manual) {
    showFn?.(r, manual); // 最新/失敗/不可は手動確認のときだけ知らせる
  }
}

/** 進行の表示（取得・確認・保留・適用）を出す状態か。失敗・中止は、閉じて見たあとは出さない。 */
function progressRelevant(us: UpdateProgress, dismissed: object | null): boolean {
  if (isUpdateActive(us.phase) || us.phase === "ready") return true;
  return (us.phase === "failed" || us.phase === "cancelled") && us !== dismissed;
}

/** App に 1 つだけマウントするホスト。 */
export function UpdateNoticeHost() {
  const [state, setState] = useState<{ r: UpdateResult | null; manual: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<object | null>(null);
  const us = useUpdateState();
  useEffect(() => {
    showFn = (r, manual) => setState({ r, manual });
    return () => {
      showFn = null;
    };
  }, []);
  // 更新を始めたウィンドウでは、ダイアログを閉じていても失敗・中止を知らせる（ほかのウィンドウには出さない）
  useEffect(() => {
    if ((us.phase === "failed" || us.phase === "cancelled") && wasUpdateStartedHere() && us !== dismissed) {
      setState((prev) => prev ?? { r: null, manual: true });
    }
  }, [us, dismissed]);
  if (!state) return null;
  const view = progressRelevant(us, dismissed) ? "progress" : "result";
  if (view === "result" && !state.r) return null; // 進行の表示を開いたが、もう出すものが無い
  return (
    <UpdateNoticeDialog
      view={view}
      state={{ r: state.r ?? { kind: "unavailable" }, manual: state.manual }}
      us={us}
      onClose={() => {
        if (us.phase === "failed" || us.phase === "cancelled") setDismissed(us);
        setState(null);
      }}
    />
  );
}

function UpdateNoticeDialog({
  view,
  state,
  us,
  onClose,
}: {
  view: "progress" | "result";
  state: { r: UpdateResult; manual: boolean };
  us: UpdateProgress;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { r } = state;
  const [startError, setStartError] = useState(false);

  let title = t("help.update.title");
  let bodyNode: React.ReactNode;
  let actions: React.ReactNode;

  if (view === "progress") {
    const releasesUrl = r.kind === "update" ? r.info.htmlUrl : RELEASES_PAGE;
    title = t("help.update.available");
    const pct = updateProgressPercent(us.bytes, us.total);
    const working = us.phase === "downloading" || us.phase === "verifying";
    bodyNode = (
      <>
        {us.version && (
          <div style={versions}>
            <span>{t("help.update.latest")}</span>
            <code style={{ ...code, borderColor: "#bcd6f0", color: "#0b5cad" }}>v{us.version}</code>
          </div>
        )}
        {working && (
          <>
            <p style={{ ...hint, margin: "0 0 8px" }} data-testid="update-status">
              {us.phase === "downloading" ? t("help.update.downloading") : t("help.update.verifying")}
              {pct !== null ? ` ${pct}%（${formatMegabytes(us.bytes)} / ${formatMegabytes(us.total)}）` : ""}
            </p>
            <div style={barOuter} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} data-testid="update-progress" data-phase={us.phase}>
              <div style={{ ...barInner, width: `${pct ?? 0}%` }} />
            </div>
          </>
        )}
        {us.phase === "ready" && (
          <p style={{ ...hint, margin: 0 }} data-testid="update-status">{t("help.update.readyOnQuit", { version: us.version ?? "" })}</p>
        )}
        {us.phase === "applying" && <p style={{ ...hint, margin: 0 }} data-testid="update-status">{t("help.update.applying")}</p>}
        {us.phase === "cancelled" && <p style={{ ...hint, margin: 0 }} data-testid="update-status">{t("help.update.cancelled")}</p>}
        {us.phase === "failed" && (
          <p style={{ ...hint, margin: 0, color: "#a33" }} data-testid="update-failed-message" data-reason={us.reason ?? ""}>
            {t(`help.update.fail.${updateFailureKind(us.reason)}`)}
          </p>
        )}
      </>
    );
    actions = (
      <>
        <div style={{ flex: 1 }} />
        {working && (
          <button style={ghostBtn} data-testid="update-cancel" onClick={() => void cancelUpdate()}>
            {t("help.update.cancel")}
          </button>
        )}
        {us.phase === "failed" && (
          <button style={ghostBtn} data-testid="update-open-page" onClick={() => openExternal(releasesUrl)}>
            {t("help.update.download")} ↗
          </button>
        )}
        {us.phase !== "applying" && !working && (
          <button style={primaryBtn} data-testid="update-close" onClick={onClose}>
            {t("common.close")}
          </button>
        )}
      </>
    );
  } else if (r.kind === "update") {
    const auto = r.info.auto?.supported === true;
    title = t("help.update.available");
    bodyNode = (
      <>
        <div style={versions}>
          <span>{t("help.update.current")}</span>
          <code style={code}>v{r.current}</code>
          <span style={{ opacity: 0.6 }}>→</span>
          <span>{t("help.update.latest")}</span>
          <code style={{ ...code, borderColor: "#bcd6f0", color: "#0b5cad" }}>v{r.latest}</code>
        </div>
        {r.info.name && <div style={relName}>{r.info.name}</div>}
        {r.info.body && <pre style={notes}>{r.info.body}</pre>}
        <p style={hint}>{auto ? t("help.update.autoHint") : t("help.update.hint")}</p>
        {startError && <p style={{ ...hint, color: "#a33" }} data-testid="update-failed-message">{t("help.update.fail.other")}</p>}
        {auto && (
          <button style={linkBtn} data-testid="update-open-page" onClick={() => openExternal(r.info.htmlUrl)}>
            {t("help.update.download")} ↗
          </button>
        )}
      </>
    );
    const begin = (mode: "now" | "onQuit") => {
      setStartError(false);
      void startUpdate(mode).then((res) => { if (!res.ok) setStartError(true); });
    };
    actions = (
      <>
        <button
          style={ghostBtn}
          data-testid="update-skip"
          onClick={() => {
            skipVersion(r.latest);
            onClose();
          }}
        >
          {t("help.update.skip")}
        </button>
        <div style={{ flex: 1 }} />
        <button style={ghostBtn} data-testid="update-later" onClick={onClose}>
          {t("help.update.later")}
        </button>
        {auto ? (
          <>
            <button style={ghostBtn} data-testid="update-on-quit" onClick={() => begin("onQuit")}>
              {t("help.update.onQuit")}
            </button>
            <button style={primaryBtn} data-testid="update-now" onClick={() => begin("now")}>
              {t("help.update.now")}
            </button>
          </>
        ) : (
          <button style={primaryBtn} data-testid="update-open-page" onClick={() => openExternal(r.info.htmlUrl)}>
            {t("help.update.download")} ↗
          </button>
        )}
      </>
    );
  } else if (r.kind === "latest") {
    bodyNode = (
      <p style={{ ...hint, margin: 0 }}>
        {t("help.update.upToDate")} <code style={code}>v{r.latest}</code>
      </p>
    );
    actions = (
      <>
        <div style={{ flex: 1 }} />
        <button style={primaryBtn} onClick={onClose}>
          {t("common.close")}
        </button>
      </>
    );
  } else {
    // unavailable / error
    bodyNode = <p style={{ ...hint, margin: 0 }}>{t("help.update.failed")}</p>;
    actions = (
      <>
        <div style={{ flex: 1 }} />
        <button style={primaryBtn} onClick={onClose}>
          {t("common.close")}
        </button>
      </>
    );
  }

  return (
    <div style={overlay} onClick={view === "progress" && isUpdateActive(us.phase) ? undefined : onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title} data-testid="update-dialog" data-view={view}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{title}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div style={{ padding: "14px 18px", overflow: "auto" }}>{bodyNode}</div>
        <div style={footer}>{actions}</div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1001,
};
const dialog: React.CSSProperties = {
  width: 520,
  maxWidth: "92vw",
  maxHeight: "84vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid #eee",
};
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const versions: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#465563", marginBottom: 10, flexWrap: "wrap" };
const relName: React.CSSProperties = { fontWeight: 600, fontSize: 14, marginBottom: 6 };
const notes: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 12,
  color: "#3a4652",
  background: "#f6f8fa",
  border: "1px solid #e2e7ec",
  borderRadius: 6,
  padding: "10px 12px",
  maxHeight: 220,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "ui-monospace, monospace",
  lineHeight: 1.5,
};
const hint: React.CSSProperties = { fontSize: 12, color: "#6b7783", lineHeight: 1.6 };
const code: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  background: "#f6f8fa",
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#e2e7ec",
  borderRadius: 5,
  padding: "2px 7px",
};
const primaryBtn: React.CSSProperties = {
  border: "1px solid #0b5cad",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "6px 14px",
};
const ghostBtn: React.CSSProperties = {
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  color: "#465563",
  cursor: "pointer",
  fontSize: 12,
  padding: "6px 14px",
};
const linkBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#0b5cad",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
  textDecoration: "underline",
};
const barOuter: React.CSSProperties = { height: 8, background: "#e8edf2", borderRadius: 4, overflow: "hidden" };
const barInner: React.CSSProperties = { height: "100%", background: "#0b5cad", transition: "width 0.2s linear" };
