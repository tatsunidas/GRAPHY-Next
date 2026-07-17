/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { fetchStatus, fetchStudies, fetchSeries, type AppStatus, type Study, type Series } from "./api";
import { parseIidLaunch } from "./iid";
import { SettingsDialog } from "./settings/SettingsDialog";
import { DbAdminDialog } from "./dbadmin/DbAdminDialog";
import { KeyboardHelp } from "./shortcuts/KeyboardHelp";
import { useGlobalShortcuts } from "./shortcuts/useGlobalShortcuts";
import { MainScreen } from "./mainscreen/MainScreen";
import { Viewer2DScreen } from "./viewer2d/Viewer2DScreen";
import { MprScreen } from "./mpr/MprScreen";
import { Viewer3DScreen } from "./viewer3d/Viewer3DScreen";
import { SlicerScreen } from "./slicer/SlicerScreen";
import { CurvedMprScreen } from "./curvedmpr/CurvedMprScreen";
import { QRScreen } from "./qr/QRScreen";
import { MonitorQcScreen } from "./monitorqc/MonitorQcScreen";
import { subscribeDbChanged, type DbChangedDetail } from "./dbEvents";
import { LogViewerHost } from "./system/LogViewer";
import { DeveloperContactHost } from "./help/DeveloperContact";
import { UninstallGuideHost } from "./help/UninstallGuide";
import { UpdateNoticeHost, runUpdateCheck } from "./help/UpdateNotice";
import { isRestartRequired, subscribeRestartRequired, clearRestartRequired } from "./restartRequiredEvents";
import { desktop } from "./desktopBridge";
import { useI18n } from "./i18n/i18n";

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // DB 変更で同一ウィンドウの一覧を再読込するためのシグナル。
  const [dbVersion, setDbVersion] = useState(0);
  // 別ウィンドウ用ルーティング（#2dviewer 等）。
  const [screen, setScreen] = useState(() => window.location.hash.replace(/^#/, ""));

  useEffect(() => {
    const onHash = () => setScreen(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    fetchStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // IHE IID 起動（web のみ・メインウィンドウのみ・1 回だけ）。URL `?studyUID=...` があれば、その study を
  // 検索ポータルを介さず 2D ビューアで直接開く（graphy-viewer-ctx に書いて #2dviewer へ遷移）。
  const iidHandledRef = useRef(false);
  useEffect(() => {
    if (iidHandledRef.current) return;
    if (!status || status.mode !== "web") return; // IID は web モード限定
    if (screen !== "") return; // メインウィンドウ（別ウィンドウ #2dviewer 等では実行しない）
    const iid = parseIidLaunch(window.location.search);
    if (!iid) return;
    iidHandledRef.current = true;
    void (async () => {
      try {
        // StudyInstanceUID で直接取得。取れなければ最小 Study を組み立てて続行。
        let study: Study | null = null;
        try {
          const studies = await fetchStudies({ studyInstanceUid: iid.studyUID });
          study = studies[0] ?? null;
        } catch {
          /* フォールバックへ */
        }
        if (!study) {
          study = {
            studyInstanceUid: iid.studyUID,
            patientId: "",
            patientName: null,
            studyDate: null,
            studyDescription: null,
            modality: null,
            numberOfInstances: 0,
          };
        }
        // series: 指定があればそれ、無ければ先頭シリーズ。
        const list = await fetchSeries(iid.studyUID).catch(() => [] as Series[]);
        let series: Series | undefined = iid.seriesUID
          ? list.find((s) => s.seriesInstanceUid === iid.seriesUID)
          : undefined;
        if (!series) series = list[0];
        localStorage.setItem("graphy-viewer-ctx", JSON.stringify({ study, series, ts: Date.now() }));
        window.location.hash = "2dviewer"; // Viewer2DScreen がマウント時に ctx を読んで開く
      } catch {
        /* 失敗時はメイン画面のまま（検索ポータルから開ける） */
      }
    })();
  }, [status, screen]);

  // 起動時の更新確認（メインウィンドウのみ・デスクトップのみ）。新版があり未スキップの場合だけ通知する。
  // 別ウィンドウ（#2dviewer 等）では二重通知を避けるため実行しない。
  useEffect(() => {
    if (screen !== "") return;
    void runUpdateCheck(false);
  }, [screen]);

  // 他ウィンドウの DB 変更（Slicer の派生シリーズ保存・DbAdmin 編集等）を受けて、
  // このウィンドウの一覧を現在の検索条件で再読込する（MainScreen は reloadKey+dbVersion で再検索）。
  useEffect(() => {
    return subscribeDbChanged(() => setDbVersion((v) => v + 1));
  }, []);

  useGlobalShortcuts({
    "open-settings": () => setSettingsOpen(true),
    "open-db": () => {
      if (status?.mode === "standalone") setDbOpen(true);
    },
    "show-help": () => setHelpOpen(true),
    // Esc: 開いているダイアログを閉じる（ビューア実装後はビューア側で表示リセットに割当）
    "close-dialog": () => {
      setSettingsOpen(false);
      setDbOpen(false);
      setHelpOpen(false);
    },
  });

  // モニター診断（目視テストパターン）は専用フルスクリーンウィンドウ。
  // 通常の chrome/オーバーレイを出さず、パターン画面のみを描画する。
  if (screen === "monitorqc") {
    return <MonitorQcScreen />;
  }

  return (
    <>
      {screen === "2dviewer" ? (
        <Viewer2DScreen status={status} />
      ) : screen === "mpr" ? (
        <MprScreen status={status} />
      ) : screen === "viewer3d" ? (
        <Viewer3DScreen status={status} />
      ) : screen === "slicer" ? (
        <SlicerScreen status={status} />
      ) : screen === "curvedmpr" ? (
        <CurvedMprScreen status={status} />
      ) : screen === "qr" ? (
        <QRScreen status={status} />
      ) : (
        <MainScreen
          status={status}
          error={error}
          dbVersion={dbVersion}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDb={() => setDbOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />
      )}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* DB 管理。編集成功で同一ウィンドウの一覧を再読込（dbVersion）＋他ウィンドウへ通知（dbEvents）。 */}
      <DbAdminDialog
        open={dbOpen}
        onClose={() => setDbOpen(false)}
        onChanged={() => setDbVersion((v) => v + 1)}
      />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* System メニューの「Log」ビューア（全ウィンドウ共通・非モーダル）。 */}
      <LogViewerHost />
      {/* Help メニューの「Contact to developer」ダイアログ（全ウィンドウ共通）。 */}
      <DeveloperContactHost />
      {/* Help メニューの「Uninstall」ガイド（アンインストーラの場所・手順）。 */}
      <UninstallGuideHost />
      {/* Help メニューの「更新を確認」／起動時チェックの通知ダイアログ。 */}
      <UpdateNoticeHost />
      {/* 別ウィンドウ（2D Viewer）では DB 変更時に再読込/開き直しをポップアップで促す。 */}
      {screen === "2dviewer" && <DbChangeNotice />}
      {/* DICOM 自局設定（SCP ポート/バインドアドレス等）を変更した後、全ウィンドウで再起動を促す。 */}
      <RestartRequiredNotice />
    </>
  );
}

/** SCP リスナー起動時にしか反映されない設定（自局 AE）の変更後、再起動を促すバナー。 */
function RestartRequiredNotice() {
  const { t } = useI18n();
  const [required, setRequired] = useState(() => isRestartRequired());
  const [relaunching, setRelaunching] = useState(false);

  useEffect(() => subscribeRestartRequired(setRequired), []);

  if (!required) return null;

  const canRelaunch = !!desktop()?.relaunch;

  const restart = async () => {
    setRelaunching(true);
    clearRestartRequired();
    try {
      await desktop()?.relaunch?.();
    } catch {
      setRelaunching(false);
    }
  };

  return (
    <div style={noticeBar}>
      <span>{t("restartNotice.message")}</span>
      {canRelaunch ? (
        <button style={noticeBtn} onClick={() => void restart()} disabled={relaunching}>
          {relaunching ? t("restartNotice.restarting") : t("restartNotice.restart")}
        </button>
      ) : (
        <span style={{ color: "#8a7b3a" }}>{t("restartNotice.manual")}</span>
      )}
      <button style={noticeDismiss} onClick={() => setRequired(false)} aria-label={t("common.close")}>
        ✕
      </button>
    </div>
  );
}

/** 2D Viewer ウィンドウで DB 変更を購読し、「再読込/開き直し」を促すバナー。 */
function DbChangeNotice() {
  const { t } = useI18n();
  const [notice, setNotice] = useState<DbChangedDetail | null>(null);

  useEffect(() => {
    return subscribeDbChanged((detail) => {
      // 当該スタディが本ウィンドウで利用中かをベストエフォート判定（起動コンテキストと突き合わせ）。
      // マルチタイルで複数スタディを開いている場合があるため、判定不能時は安全側で通知する。
      let relevant = true;
      try {
        const raw = localStorage.getItem("graphy-viewer-ctx");
        const ctxStudy = raw ? (JSON.parse(raw)?.study?.studyInstanceUid as string | undefined) : undefined;
        if (ctxStudy && detail.studyUids && detail.studyUids.length > 0) {
          relevant = detail.studyUids.includes(ctxStudy);
        }
      } catch {
        relevant = true;
      }
      if (relevant) setNotice(detail);
    });
  }, []);

  if (!notice) return null;

  return (
    <div data-testid="db-change-notice" style={noticeBar}>
      <span>{t("dbnotice.message")}</span>
      <button style={noticeBtn} onClick={() => window.location.reload()}>
        {t("dbnotice.reload")}
      </button>
      <button
        data-testid="db-change-notice-dismiss"
        style={noticeDismiss}
        onClick={() => setNotice(null)}
        aria-label={t("common.close")}
      >
        ✕
      </button>
    </div>
  );
}

const noticeBar: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 2000,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 14px",
  background: "#fff4ce",
  borderBottom: "1px solid #e6d8a8",
  color: "#5a4b00",
  fontSize: 13,
  fontFamily: "system-ui, sans-serif",
};
const noticeBtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdb86a",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const noticeDismiss: React.CSSProperties = {
  marginLeft: "auto",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "#8a7b3a",
  fontSize: 14,
};
