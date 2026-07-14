/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { type ViewerActions } from "./Viewer2DToolbar";
import { presetLabel } from "./wlPresets";
import { useWlPresets } from "./wlPresetStore";
import { TOOL_IDS } from "../viewer/toolIds";
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
  /** サブメニューを持つ場合や区切り線では onClick 不要。 */
  onClick?: () => void;
  checked?: boolean;
  /** ▸ で展開する子項目（例: W/L プリセット）。 */
  submenu?: MenuItem[];
  /** この項目の直前に区切り線を挿入。 */
  separatorBefore?: boolean;
  /** ボタンではなく任意の UI を描画する（例: レイアウトの行×列入力）。close で親メニューを閉じる。 */
  render?: (close: () => void) => React.ReactNode;
}

/** レイアウトのプリセット（行 × 列）。 */
const LAYOUT_PRESETS: [number, number][] = [
  [1, 1],
  [1, 2],
  [2, 1],
  [2, 2],
  [1, 3],
  [3, 1],
  [2, 3],
  [3, 3],
];

/** 2D Viewer 画面メニューバー。MainScreen の MenuBar と同じドロップダウン流儀。 */
export function Viewer2DMenuBar({
  actions,
  refLines,
  activeTool,
  gridRows,
  gridCols,
  isDemo,
  onClose,
}: {
  actions: ViewerActions;
  refLines: boolean;
  activeTool: string;
  gridRows: number;
  gridCols: number;
  /** 公開デモ（backendが該当APIを403にする）。ImageJ/プラグイン実行/システムログ・メモリモニタを隠す。 */
  isDemo: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const presets = useWlPresets();
  const pluginItems = usePluginMenu("viewer2d.menu", (m) => ({
    surface: "viewer2d.menu",
    pluginId: m.id,
    t,
    notify: (msg) => window.alert(msg),
    runBackend: (payload) => runPluginBackend(m.id, payload),
    actions,
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
      items: [{ label: t("common.close"), onClick: onClose }],
    },
    {
      id: "view",
      label: t("viewer2d.menu.view"),
      items: [
        { label: t("viewer2d.refLines.label"), onClick: actions.toggleRefLines, checked: refLines },
        {
          label: t("viewer2d.layout"),
          submenu: [
            {
              label: t("viewer2d.layout.auto"),
              checked: gridRows === 0 && gridCols === 0,
              onClick: () => actions.setLayoutGrid(0, 0),
            },
            ...LAYOUT_PRESETS.map(([r, c], i) => ({
              label: `${r} × ${c}`,
              checked: gridRows === r && gridCols === c,
              onClick: () => actions.setLayoutGrid(r, c),
              separatorBefore: i === 0,
            })),
            {
              label: t("viewer2d.layout.custom"),
              separatorBefore: true,
              render: (close: () => void) => (
                <LayoutCustomForm actions={actions} rows={gridRows} cols={gridCols} close={close} />
              ),
            },
          ],
        },
        { label: t("viewer2d.tb.syncOn"), onClick: () => actions.setSyncTargets(true) },
        { label: t("viewer2d.tb.syncOff"), onClick: () => actions.setSyncTargets(false) },
        { label: `${t("main.toolbar.viewer3d")}…`, onClick: () => actions.launchViewer3D() },
        { label: `${t("main.toolbar.mpr")}…`, onClick: () => actions.launchMpr() },
        { label: `${t("main.toolbar.slicer")}…`, onClick: () => actions.launchSlicer() },
        { label: `${t("curvedMpr.title")}…`, onClick: () => actions.launchCurvedMpr() },
      ],
    },
    {
      id: "image",
      label: t("main.menu.image"),
      items: [
        {
          label: t("viewer2d.wl.preset"),
          submenu: [
            { label: t("viewer2d.wl.default"), onClick: actions.resetWindow },
            ...presets.map((p) => ({
              label: presetLabel(p, t),
              onClick: () => actions.setWindowLevel(p.center, p.width),
            })),
            { label: t("viewer2d.wl.edit"), onClick: actions.editPresets, separatorBefore: true },
          ],
        },
        { label: `${t("viewer2d.wl.adjust.title")}…`, onClick: () => actions.openWindowLevel() },
        { label: `${t("suv.menu")}…`, onClick: () => actions.openSuv() },
        { label: t("viewer.invert"), onClick: actions.invert },
        { label: `${t("viewer.lut")}…`, onClick: actions.openLut },
        { label: t("viewer.rotate"), onClick: actions.rotate90 },
        { label: t("viewer.flipH"), onClick: actions.flipH },
        { label: t("viewer.flipV"), onClick: actions.flipV },
        { label: t("viewer.fit"), onClick: actions.fit },
        { label: t("viewer.reset"), onClick: actions.reset },
        { label: t("viewer.undo"), onClick: actions.undo },
        { label: t("viewer.redo"), onClick: actions.redo },
        {
          label: t("viewer2d.menu.sort"),
          separatorBefore: true,
          submenu: [
            { label: t("viewer2d.sort.instanceAsc"), onClick: () => actions.sort("instanceAsc") },
            { label: t("viewer2d.sort.instanceDesc"), onClick: () => actions.sort("instanceDesc") },
            { label: t("viewer2d.sort.ippAsc"), onClick: () => actions.sort("ippAsc"), separatorBefore: true },
            { label: t("viewer2d.sort.ippDesc"), onClick: () => actions.sort("ippDesc") },
          ],
        },
      ],
    },
    {
      id: "roi",
      label: t("viewer2d.menu.roi"),
      items: [
        { label: t("roiMgr.title"), onClick: actions.toggleRoiManager },
        { label: t("viewer2d.roi.length"), onClick: () => actions.setTool(TOOL_IDS.length), checked: activeTool === TOOL_IDS.length },
        { label: t("viewer2d.roi.angle"), onClick: () => actions.setTool(TOOL_IDS.angle), checked: activeTool === TOOL_IDS.angle },
        { label: t("viewer2d.roi.ellipse"), onClick: () => actions.setTool(TOOL_IDS.ellipse), checked: activeTool === TOOL_IDS.ellipse },
        { label: t("viewer2d.roi.rect"), onClick: () => actions.setTool(TOOL_IDS.rect), checked: activeTool === TOOL_IDS.rect },
        { label: t("viewer2d.roi.probe"), onClick: () => actions.setTool(TOOL_IDS.probe), checked: activeTool === TOOL_IDS.probe },
        { label: t("viewer2d.roi.clear"), onClick: actions.clearRois },
      ],
    },
    {
      id: "roiTools",
      label: t("viewer2d.menu.roiTools"),
      items: [
        { label: t("viewer2d.tool.brush"), onClick: () => actions.setTool(TOOL_IDS.brush), checked: activeTool === TOOL_IDS.brush },
        { label: t("viewer2d.tool.eraser"), onClick: () => actions.setTool(TOOL_IDS.eraser), checked: activeTool === TOOL_IDS.eraser },
        { label: t("viewer2d.tool.wand2d"), onClick: () => actions.setTool(TOOL_IDS.wand2d), checked: activeTool === TOOL_IDS.wand2d },
        { label: t("viewer2d.tool.region3d"), onClick: () => actions.setTool(TOOL_IDS.region3d), checked: activeTool === TOOL_IDS.region3d },
        { label: t("viewer2d.tool.levelset2d"), onClick: () => actions.setTool(TOOL_IDS.levelset2d), checked: activeTool === TOOL_IDS.levelset2d },
      ],
    },
    {
      id: "tools",
      label: t("main.menu.tools"),
      items: [
        { label: t("main.toolbar.tagViewer"), onClick: () => actions.openTagViewer() },
      ],
    },
    {
      id: "analysis",
      label: t("viewer2d.menu.analysis"),
      items: [
        { label: t("viewer2d.menu.histogram"), onClick: () => actions.openHistogram() },
        { label: `${t("texture.menu")}…`, onClick: () => actions.openTexture() },
        ...(isDemo ? [] : [{ label: t("viewer2d.menu.imagej"), onClick: () => actions.bridgeImageJ() }]),
      ],
    },
    {
      id: "plugins",
      label: t("viewer2d.menu.plugins"),
      items: isDemo
        ? [{ label: t("viewer2d.menu.pluginsNone"), onClick: () => actions.comingSoon(t("viewer2d.menu.plugins")) }]
        : pluginItems.length
          ? pluginItems.map((p) => ({ label: p.label, onClick: p.onClick }))
          : [{ label: t("viewer2d.menu.pluginsNone"), onClick: () => actions.comingSoon(t("viewer2d.menu.plugins")) }],
    },
    {
      id: "system",
      label: t("main.menu.system"),
      items: isDemo
        ? []
        : [
            { label: t("system.log"), onClick: () => openLogViewer() },
            { label: t("system.memoryMonitor"), onClick: () => void openMemoryMonitor(t) },
          ],
    },
    {
      id: "help",
      label: t("main.menu.help"),
      items: [
        ...(isDesktop() ? [{ label: t("help.update"), onClick: () => void runUpdateCheck(true) }] : []),
        { label: t("help.community"), onClick: () => openUsersCommunity() },
        { label: t("help.contact"), onClick: () => openDeveloperContact() },
        { label: t("help.uninstall"), onClick: () => openUninstallGuide() },
      ],
    },
  ];
  const visibleMenus = menus.filter((m) => m.items.length > 0);

  return (
    <div style={bar}>
      {visibleMenus.map((m) => (
        <div key={m.id} style={{ position: "relative" }}>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(open === m.id ? null : m.id); }}
            style={{ ...menuBtn, background: open === m.id ? "#e6effa" : "transparent" }}
          >
            {m.label}
          </button>
          {open === m.id && (
            <div style={dropdown} onClick={(e) => e.stopPropagation()}>
              {m.items.map((it) => (
                <MenuRow key={it.label} it={it} onClose={() => setOpen(null)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** ドロップダウン 1 行。submenu があればホバーで右にフライアウト展開。 */
function MenuRow({ it, onClose }: { it: MenuItem; onClose: () => void }) {
  const [hover, setHover] = useState(false);
  const sep = it.separatorBefore ? <div style={separator} /> : null;
  if (it.render) {
    return (
      <>
        {sep}
        {it.render(onClose)}
      </>
    );
  }
  if (it.submenu) {
    return (
      <>
        {sep}
        <div
          style={{ position: "relative" }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <button style={{ ...item, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{it.label}</span>
            <span style={{ marginLeft: 12, color: "#8a97a4" }}>▸</span>
          </button>
          {hover && (
            <div style={{ ...dropdown, top: -4, left: "100%" }}>
              {it.submenu.map((sub) => (
                <MenuRow key={sub.label} it={sub} onClose={onClose} />
              ))}
            </div>
          )}
        </div>
      </>
    );
  }
  return (
    <>
      {sep}
      <button onClick={() => { onClose(); it.onClick?.(); }} style={item}>
        {it.checked ? "✓ " : ""}{it.label}
      </button>
    </>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "1px 6px",
  borderBottom: "1px solid #e6eaee",
  background: "#fff",
  fontSize: 13,
};
const menuBtn: React.CSSProperties = { border: "none", borderRadius: 5, padding: "4px 12px", cursor: "pointer", fontSize: 13 };
const dropdown: React.CSSProperties = {
  position: "absolute", top: "100%", left: 0, minWidth: 200, background: "#fff",
  border: "1px solid #dfe3e8", borderRadius: 6, boxShadow: "0 6px 20px rgba(0,0,0,0.15)", padding: 4, zIndex: 50,
};
const item: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent",
  padding: "7px 10px", borderRadius: 5, fontSize: 13, color: "#222", cursor: "pointer",
};
const separator: React.CSSProperties = { height: 1, background: "#e6eaee", margin: "4px 6px" };

/**
 * レイアウトの任意 行×列 入力フォーム（サブメニュー末尾に埋め込む）。
 * 適用でメニューを閉じる。行/列は 1–12 に丸める。
 */
function LayoutCustomForm({
  actions,
  rows,
  cols,
  close,
}: {
  actions: ViewerActions;
  rows: number;
  cols: number;
  close: () => void;
}) {
  const { t } = useI18n();
  const [r, setR] = useState(rows > 0 ? rows : 2);
  const [c, setC] = useState(cols > 0 ? cols : 2);
  const apply = () => {
    const rr = Math.max(1, Math.min(12, Math.floor(r) || 1));
    const cc = Math.max(1, Math.min(12, Math.floor(c) || 1));
    actions.setLayoutGrid(rr, cc);
    close();
  };
  return (
    <div style={customForm} onClick={(e) => e.stopPropagation()}>
      <input
        type="number"
        min={1}
        max={12}
        value={r}
        onChange={(e) => setR(Number(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
        style={miniInput}
        aria-label={t("viewer2d.layout.rows")}
        title={t("viewer2d.layout.rows")}
      />
      <span style={{ color: "#8a97a4" }}>×</span>
      <input
        type="number"
        min={1}
        max={12}
        value={c}
        onChange={(e) => setC(Number(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
        style={miniInput}
        aria-label={t("viewer2d.layout.colsN")}
        title={t("viewer2d.layout.colsN")}
      />
      <button onClick={apply} style={applyBtn}>{t("viewer2d.layout.apply")}</button>
    </div>
  );
}

const customForm: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
};
const miniInput: React.CSSProperties = {
  width: 46, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 13, padding: "2px 4px", textAlign: "center",
};
const applyBtn: React.CSSProperties = {
  border: "1px solid #0b5cad", borderRadius: 5, background: "#0b5cad", color: "#fff",
  cursor: "pointer", fontSize: 12, padding: "3px 12px",
};
