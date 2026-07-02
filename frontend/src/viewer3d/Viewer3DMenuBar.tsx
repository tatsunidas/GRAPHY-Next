/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer ウィンドウのメニューバー。現状は View メニューのみ:
 *  - Cinematic rendering settings…（Cinematic 設定ダイアログ）
 *  - Representation State ▸ Set / apply state…（表示状態の指定/再現ダイアログ）
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";

export function Viewer3DMenuBar({
  onOpenCinematic,
  onOpenReprState,
  rotateMode,
  onSetRotate,
}: {
  onOpenCinematic: () => void;
  onOpenReprState: () => void;
  rotateMode: "camera" | "actor";
  onSetRotate: (mode: "camera" | "actor") => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState<"repr" | "rotate" | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setSubOpen(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  const run = (fn: () => void) => {
    setOpen(false);
    setSubOpen(null);
    fn();
  };

  return (
    <div style={bar}>
      <div style={{ position: "relative" }}>
        <button
          style={{ ...menuBtn, background: open ? "#1f2937" : "transparent" }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {t("viewer3d.menu.view")}
        </button>
        {open && (
          <div style={dropdown} onClick={(e) => e.stopPropagation()}>
            <button style={item} onClick={() => run(onOpenCinematic)}>
              {t("viewer3d.menu.cinematic")}
            </button>
            <div
              style={{ position: "relative" }}
              onMouseEnter={() => setSubOpen("repr")}
              onMouseLeave={() => setSubOpen(null)}
            >
              <button style={{ ...item, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{t("viewer3d.menu.reprState")}</span>
                <span style={{ marginLeft: 12, color: "#8a97a4" }}>▸</span>
              </button>
              {subOpen === "repr" && (
                <div style={{ ...dropdown, top: -4, left: "100%" }}>
                  <button style={item} onClick={() => run(onOpenReprState)}>
                    {t("viewer3d.menu.reprStateEdit")}
                  </button>
                </div>
              )}
            </div>
            <div
              style={{ position: "relative" }}
              onMouseEnter={() => setSubOpen("rotate")}
              onMouseLeave={() => setSubOpen(null)}
            >
              <button style={{ ...item, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{t("viewer3d.menu.rotate")}</span>
                <span style={{ marginLeft: 12, color: "#8a97a4" }}>▸</span>
              </button>
              {subOpen === "rotate" && (
                <div style={{ ...dropdown, top: -4, left: "100%" }}>
                  {(["actor", "camera"] as const).map((m) => (
                    <button key={m} style={item} onClick={() => run(() => onSetRotate(m))}>
                      {rotateMode === m ? "● " : "　"}
                      {t(`viewer3d.menu.rotate.${m}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  background: "#0d1013",
  borderBottom: "1px solid #23292f",
  padding: "2px 6px",
};
const menuBtn: React.CSSProperties = {
  border: "none",
  borderRadius: 5,
  padding: "3px 12px",
  cursor: "pointer",
  fontSize: 13,
  color: "#e6eaee",
};
const dropdown: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  minWidth: 220,
  background: "#14181c",
  border: "1px solid #2c343b",
  borderRadius: 6,
  padding: 4,
  zIndex: 1100,
  boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
};
const item: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  color: "#e6eaee",
  border: "none",
  borderRadius: 4,
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 13,
  whiteSpace: "nowrap",
};
