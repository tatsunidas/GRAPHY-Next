/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";

/**
 * 横一列のツールバー。幅に収まらないボタンは行末の「⋯」ボタンのポップアップに移す。
 *
 * 子はそのまま並べる（JSX・testid・状態は呼び出し側のまま）。収まらない子は `visibility:hidden` にして
 * 幅は保ち（測り直しが安定する）、ポップアップを開いたときだけ同じ要素をもう一度描く。
 * 全部収まるときは「⋯」を出さず、従来の横並びと同じ。区切り線は子に `data-sep` を付けて示す。
 */
export function OverflowRow({
  style,
  children,
  moreTestId,
}: {
  style: React.CSSProperties;
  children: React.ReactNode;
  moreTestId?: string;
}) {
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const items = Children.toArray(children);
  // 隠す先頭の子の番号（-1＝全部収まる）。
  const [cut, setCut] = useState(-1);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // 各子が区切り線か（DOM の data-sep から。`<Sep />` のようなコンポーネントも拾うため DOM で見る）。
  const sepRef = useRef<boolean[]>([]);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    // 子ごとのラッパは display:contents（箱を持たない）ので、実際の要素は firstElementChild。
    const kids = (Array.from(row.children) as HTMLElement[])
      .filter((e) => e.dataset.overflowMore === undefined)
      .map((w) => (w.firstElementChild as HTMLElement | null) ?? w);
    sepRef.current = kids.map((e) => e.dataset.sep !== undefined);
    const avail = row.clientWidth;
    const rightEdge = (e: HTMLElement) => e.offsetLeft + e.offsetWidth;
    if (kids.length === 0 || rightEdge(kids[kids.length - 1]) <= avail) {
      setCut(-1);
      return;
    }
    const reserve = (moreRef.current?.offsetWidth ?? 40) + 6;
    let n = kids.findIndex((e) => rightEdge(e) > avail - reserve);
    if (n < 0) n = kids.length;
    // 区切り線が行末に残らないよう、境の直前の区切りは隠す側へ回す。
    while (n > 0 && sepRef.current[n - 1]) n--;
    setCut(n);
  }, []);

  useLayoutEffect(() => {
    measure();
    const row = rowRef.current;
    if (!row) return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [measure]);
  // 子の中身（ラベルの長さ・disabled など）が変わっても幅が変わるので、描画のたびに測り直す。
  useLayoutEffect(() => { measure(); });

  const placePopup = useCallback(() => {
    const b = moreRef.current?.getBoundingClientRect();
    if (!b) return;
    const w = Math.min(360, window.innerWidth - 16);
    setPos({ top: Math.round(b.bottom + 4), left: Math.max(8, Math.min(Math.round(b.right - w), window.innerWidth - w - 8)) });
  }, []);

  useLayoutEffect(() => { if (open) placePopup(); }, [open, placePopup]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (popRef.current?.contains(n) || moreRef.current?.contains(n)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // 全部収まるようになったら閉じる。
  useEffect(() => { if (cut < 0) setOpen(false); }, [cut]);

  const hidden = cut < 0 ? [] : items.slice(cut);
  const hiddenPlain = hidden.filter((_, k) => !sepRef.current[cut + k]);

  return (
    <div ref={rowRef} style={{ ...style, position: "relative", overflow: "hidden", overflowX: "hidden", flexWrap: "nowrap" }}>
      {items.map((el, i) => (
        <div key={i} style={cut >= 0 && i >= cut ? hiddenWrap : contentsWrap}>{el}</div>
      ))}
      {cut >= 0 && (
        <button
          ref={moreRef}
          type="button"
          data-overflow-more=""
          data-testid={moreTestId}
          aria-haspopup="true"
          aria-expanded={open}
          title={t("toolbar.more")}
          onClick={() => setOpen((v) => !v)}
          style={moreBtn}
        >
          ⋯
        </button>
      )}
      {open && cut >= 0 && pos &&
        createPortal(
          <div
            ref={popRef}
            role="menu"
            data-testid={moreTestId ? `${moreTestId}-popup` : undefined}
            style={{ ...popup, top: pos.top, left: pos.left, width: Math.min(360, window.innerWidth - 16) }}
            onClick={(e) => {
              // ボタンを押したら閉じる（select・input の操作では閉じない）。
              if ((e.target as HTMLElement).closest("button")) setOpen(false);
            }}
          >
            {hiddenPlain.map((el, i) => (
              <div key={i} style={{ display: "contents" }}>{el}</div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

const contentsWrap: React.CSSProperties = { display: "contents" };
// 幅は保ったまま見えなく・押せなくする（visibility は子孫へ継承され、クリックも Tab も効かなくなる）。
const hiddenWrap: React.CSSProperties = { display: "contents", visibility: "hidden" };

const moreBtn: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: "50%",
  transform: "translateY(-50%)",
  minWidth: 34,
  height: 30,
  padding: "0 10px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  fontWeight: 700,
};

const popup: React.CSSProperties = {
  position: "fixed",
  zIndex: 3000,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  padding: 8,
  background: "#fff",
  border: "1px solid #cdd5de",
  borderRadius: 8,
  boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
  boxSizing: "border-box",
};
