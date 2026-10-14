/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";

export type CopyChoice = "roi" | "image" | "cancel";

let pending: ((c: CopyChoice) => void) | null = null;
const listeners = new Set<(open: boolean) => void>();

/** 「ROI も含めてキャプチャしますか？」を出して、答えを待つ。窓は {@link CopyImageAskHost} が出す。 */
export function askCopyWithRoi(): Promise<CopyChoice> {
  if (listeners.size === 0) return Promise.resolve("image");
  pending?.("cancel");
  return new Promise((resolve) => {
    pending = resolve;
    for (const l of listeners) l(true);
  });
}

function answer(c: CopyChoice): void {
  const p = pending;
  pending = null;
  for (const l of listeners) l(false);
  p?.(c);
}

/** 画面に 1 つだけ置く。 */
export function CopyImageAskHost() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    listeners.add(setOpen);
    return () => {
      listeners.delete(setOpen);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div style={backdrop} onClick={() => answer("cancel")} data-testid="copy-image-ask">
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={titleBar}>{t("viewer2d.copyImageAskRoi")}</div>
        <div style={buttons}>
          <button type="button" onClick={() => answer("cancel")} data-testid="copy-image-cancel">
            {t("common.cancel")}
          </button>
          <button type="button" onClick={() => answer("image")} data-testid="copy-image-only">
            {t("viewer2d.copyImageOnly")}
          </button>
          <button type="button" style={primary} onClick={() => answer("roi")} data-testid="copy-image-with-roi" autoFocus>
            {t("viewer2d.copyImageWithRoi")}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000,
};
const card: React.CSSProperties = {
  width: 420, maxWidth: "92vw", background: "#fff", borderRadius: 10,
  boxShadow: "0 10px 40px rgba(0,0,0,0.3)", padding: 16, fontSize: 13, color: "#222",
};
const titleBar: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginBottom: 16 };
const buttons: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8 };
const primary: React.CSSProperties = { background: "#1a5fb4", color: "#fff", border: "1px solid #1a5fb4", borderRadius: 4, padding: "4px 12px" };
