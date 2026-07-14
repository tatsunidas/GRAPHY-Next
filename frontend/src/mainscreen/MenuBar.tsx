/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { type ToolKind, type ViewerKind } from "./Toolbar";
import { useI18n } from "../i18n/i18n";
import { usePluginMenu, runPluginBackend } from "../plugins/pluginRegistry";
import { openLogViewer } from "../system/LogViewer";
import { openMemoryMonitor } from "../system/memoryMonitor";
import { openUsersCommunity } from "../help/links";
import { openDeveloperContact } from "../help/DeveloperContact";
import { openUninstallGuide } from "../help/UninstallGuide";
import { runUpdateCheck } from "../help/UpdateNotice";
import { isDesktop } from "../desktopBridge";

interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function MenuBar({
  isStandalone,
  canImport,
  isDemo,
  selectedStudyUid,
  onImport,
  onOpenTool,
  onOpenViewer,
  onOpenSettings,
  onOpenDb,
  onOpenHelp,
}: {
  isStandalone: boolean;
  canImport: boolean;
  /** 公開デモ（backendが該当APIを403にする）。Export/Anonymizer/SeriesExtractor/QR/プラグイン実行/
   * システムログ・メモリモニタのメニュー項目を隠す。 */
  isDemo: boolean;
  selectedStudyUid: string | null;
  onImport: () => void;
  onOpenTool: (kind: ToolKind) => void;
  onOpenViewer: (kind: ViewerKind) => void;
  onOpenSettings: () => void;
  onOpenDb: () => void;
  onOpenHelp: () => void;
}) {
  const { t } = useI18n();
  const pluginItems = usePluginMenu("mainscreen.menu", (m) => ({
    surface: "mainscreen.menu",
    pluginId: m.id,
    t,
    notify: (msg) => window.alert(msg),
    runBackend: (payload) => runPluginBackend(m.id, payload),
    selectedStudyUid,
  }));
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const close = () => setOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const menus: { id: string; label: string; items: MenuItem[] }[] = [
    {
      id: "file",
      label: t("main.menu.file"),
      items: [
        { label: t("main.import.action"), onClick: onImport, disabled: !canImport },
        ...(isDemo ? [] : [{ label: t("main.toolbar.export"), onClick: () => onOpenTool("export") }]),
        { label: t("main.toolbar.send"), onClick: () => onOpenTool("send") },
        ...(isDemo ? [] : [{ label: t("qr.title"), onClick: () => onOpenViewer("qr") }]),
        { label: t("main.toolbar.nonDicomImport"), onClick: () => onOpenTool("nonDicomImport") },
      ],
    },
    {
      id: "function",
      label: t("main.menu.function"),
      items: [
        ...(isDemo ? [] : [{ label: t("main.toolbar.anonymizer"), onClick: () => onOpenTool("anonymizer") }]),
        { label: t("main.toolbar.tagExtractor"), onClick: () => onOpenTool("tagExtractor") },
        { label: t("main.toolbar.tagViewer"), onClick: () => onOpenTool("tagViewer") },
        ...(isDemo ? [] : [{ label: t("main.toolbar.seriesExtractor"), onClick: () => onOpenTool("seriesExtractor") }]),
        { label: t("main.toolbar.report"), onClick: () => onOpenTool("report") },
        { label: t("main.toolbar.reportManager"), onClick: () => onOpenTool("reportManager") },
      ],
    },
    {
      id: "image",
      label: t("main.menu.image"),
      items: [
        { label: t("main.toolbar.viewer2d"), onClick: () => onOpenViewer("2d") },
        { label: t("main.toolbar.viewer3d"), onClick: () => onOpenViewer("3d") },
        { label: t("main.toolbar.mpr"), onClick: () => onOpenViewer("mpr") },
        { label: t("main.toolbar.slicer"), onClick: () => onOpenViewer("slicer") },
      ],
    },
    {
      id: "plugins",
      label: t("main.menu.plugins"),
      items: isDemo
        ? [{ label: t("main.menu.pluginsNone"), onClick: () => {}, disabled: true }]
        : pluginItems.length
          ? pluginItems.map((p) => ({ label: p.label, onClick: p.onClick }))
          : [{ label: t("main.menu.pluginsNone"), onClick: () => {}, disabled: true }],
    },
    {
      id: "system",
      label: t("main.menu.system"),
      items: [
        { label: t("app.btn.settingsTitle"), onClick: onOpenSettings },
        { label: t("app.btn.dbTitle"), onClick: onOpenDb, disabled: !isStandalone },
        ...(isDemo
          ? []
          : [
              { label: t("system.log"), onClick: openLogViewer },
              { label: t("system.memoryMonitor"), onClick: () => void openMemoryMonitor(t) },
            ]),
      ],
    },
    {
      id: "help",
      label: t("main.menu.help"),
      items: [
        { label: t("sc.title"), onClick: onOpenHelp },
        ...(isDesktop() ? [{ label: t("help.update"), onClick: () => void runUpdateCheck(true) }] : []),
        { label: t("help.community"), onClick: openUsersCommunity },
        { label: t("help.contact"), onClick: openDeveloperContact },
        { label: t("help.uninstall"), onClick: openUninstallGuide },
      ],
    },
  ];

  return (
    <div style={bar}>
      {menus.map((m) => (
        <div key={m.id} style={{ position: "relative" }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(open === m.id ? null : m.id);
            }}
            style={{ ...menuBtn, background: open === m.id ? "#e6effa" : "transparent" }}
          >
            {m.label}
          </button>
          {open === m.id && (
            <div style={dropdown} onClick={(e) => e.stopPropagation()}>
              {m.items.map((it) => (
                <button
                  key={it.label}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(null);
                    if (!it.disabled) it.onClick();
                  }}
                  style={{ ...item, color: it.disabled ? "#aab2bb" : "#222", cursor: it.disabled ? "default" : "pointer" }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "2px 8px",
  borderBottom: "1px solid #e6eaee",
  background: "#fff",
  fontSize: 13,
};
const menuBtn: React.CSSProperties = {
  border: "none",
  borderRadius: 5,
  padding: "5px 12px",
  cursor: "pointer",
  fontSize: 13,
};
const dropdown: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  minWidth: 200,
  background: "#fff",
  border: "1px solid #dfe3e8",
  borderRadius: 6,
  boxShadow: "0 6px 20px rgba(0,0,0,0.15)",
  padding: 4,
  zIndex: 50,
};
const item: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "transparent",
  padding: "7px 10px",
  borderRadius: 5,
  fontSize: 13,
};
