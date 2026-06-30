/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { type ViewerActions } from "./Viewer2DToolbar";
import { WL_PRESETS } from "./wlPresets";
import { TOOL_IDS } from "../viewer/toolIds";

interface MenuItem {
  label: string;
  onClick: () => void;
  checked?: boolean;
}

/** 2D Viewer 画面メニューバー。MainScreen の MenuBar と同じドロップダウン流儀。 */
export function Viewer2DMenuBar({
  actions,
  refLines,
  activeTool,
  onClose,
}: {
  actions: ViewerActions;
  refLines: boolean;
  activeTool: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
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
        { label: `${t("viewer2d.layout")}: ${t("viewer2d.layout.auto")}`, onClick: () => actions.setLayoutCols(0) },
        { label: `${t("viewer2d.layout")}: 2 ${t("viewer2d.layout.cols")}`, onClick: () => actions.setLayoutCols(2) },
        { label: `${t("viewer2d.layout")}: 3 ${t("viewer2d.layout.cols")}`, onClick: () => actions.setLayoutCols(3) },
        { label: t("viewer2d.tb.syncOn"), onClick: () => actions.setSyncTargets(true) },
        { label: t("viewer2d.tb.syncOff"), onClick: () => actions.setSyncTargets(false) },
        { label: t("main.toolbar.viewer3d"), onClick: () => actions.comingSoon(t("main.toolbar.viewer3d")) },
        { label: t("main.toolbar.mpr"), onClick: () => actions.comingSoon(t("main.toolbar.mpr")) },
        { label: t("main.toolbar.slicer"), onClick: () => actions.comingSoon(t("main.toolbar.slicer")) },
      ],
    },
    {
      id: "image",
      label: t("main.menu.image"),
      items: [
        { label: `${t("viewer2d.wl.preset")}: ${t("viewer2d.wl.default")}`, onClick: actions.resetWindow },
        ...WL_PRESETS.map((p) => ({
          label: `${t("viewer2d.wl.preset")}: ${t(p.labelKey)}`,
          onClick: () => actions.setWindowLevel(p.center, p.width),
        })),
        { label: t("viewer.invert"), onClick: actions.invert },
        { label: `${t("viewer.lut")}…`, onClick: actions.openLut },
        { label: t("viewer.rotate"), onClick: actions.rotate90 },
        { label: t("viewer.flipH"), onClick: actions.flipH },
        { label: t("viewer.flipV"), onClick: actions.flipV },
        { label: t("viewer.fit"), onClick: actions.fit },
        { label: t("viewer.reset"), onClick: actions.reset },
        { label: t("viewer.undo"), onClick: actions.undo },
        { label: t("viewer.redo"), onClick: actions.redo },
        { label: t("viewer2d.menu.sort"), onClick: () => actions.comingSoon(t("viewer2d.menu.sort")) },
      ],
    },
    {
      id: "roi",
      label: t("viewer2d.menu.roi"),
      items: [
        { label: t("viewer2d.roi.length"), onClick: () => actions.setTool(TOOL_IDS.length), checked: activeTool === TOOL_IDS.length },
        { label: t("viewer2d.roi.angle"), onClick: () => actions.setTool(TOOL_IDS.angle), checked: activeTool === TOOL_IDS.angle },
        { label: t("viewer2d.roi.ellipse"), onClick: () => actions.setTool(TOOL_IDS.ellipse), checked: activeTool === TOOL_IDS.ellipse },
        { label: t("viewer2d.roi.rect"), onClick: () => actions.setTool(TOOL_IDS.rect), checked: activeTool === TOOL_IDS.rect },
        { label: t("viewer2d.roi.probe"), onClick: () => actions.setTool(TOOL_IDS.probe), checked: activeTool === TOOL_IDS.probe },
        { label: t("viewer2d.roi.clear"), onClick: actions.clearRois },
      ],
    },
    {
      id: "tools",
      label: t("main.menu.tools"),
      items: [
        { label: t("viewer2d.tool.brush"), onClick: () => actions.setTool(TOOL_IDS.brush), checked: activeTool === TOOL_IDS.brush },
        { label: t("viewer2d.tool.eraser"), onClick: () => actions.setTool(TOOL_IDS.eraser), checked: activeTool === TOOL_IDS.eraser },
      ],
    },
    {
      id: "analysis",
      label: t("viewer2d.menu.analysis"),
      items: [
        { label: t("viewer2d.menu.histogram"), onClick: () => actions.comingSoon(t("viewer2d.menu.histogram")) },
        { label: t("viewer2d.menu.imagej"), onClick: () => actions.comingSoon(t("viewer2d.menu.imagej")) },
      ],
    },
    {
      id: "plugins",
      label: t("viewer2d.menu.plugins"),
      items: [
        { label: t("viewer2d.menu.pluginsNone"), onClick: () => actions.comingSoon(t("viewer2d.menu.plugins")) },
      ],
    },
  ];

  return (
    <div style={bar}>
      {menus.map((m) => (
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
                <button
                  key={it.label}
                  onClick={() => { setOpen(null); it.onClick(); }}
                  style={item}
                >
                  {it.checked ? "✓ " : ""}{it.label}
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
