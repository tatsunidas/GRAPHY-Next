/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { fetchStatus, type AppStatus } from "./api";
import { SettingsDialog } from "./settings/SettingsDialog";
import { DbAdminDialog } from "./dbadmin/DbAdminDialog";
import { KeyboardHelp } from "./shortcuts/KeyboardHelp";
import { useGlobalShortcuts } from "./shortcuts/useGlobalShortcuts";
import { MainScreen } from "./mainscreen/MainScreen";
import { Viewer2DScreen } from "./viewer2d/Viewer2DScreen";

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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

  return (
    <>
      {screen === "2dviewer" ? (
        <Viewer2DScreen status={status} />
      ) : (
        <MainScreen
          status={status}
          error={error}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenDb={() => setDbOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />
      )}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DbAdminDialog open={dbOpen} onClose={() => setDbOpen(false)} />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
