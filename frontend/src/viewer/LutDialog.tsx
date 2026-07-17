/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { fetchLutNames, fetchLutData, type LutData } from "../api";
import { useI18n } from "../i18n/i18n";

// ── カラーバーキャンバス ─────────────────────────────────────────

export function ColorBar({ lut }: { lut: LutData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imgData = ctx.createImageData(256, 1);
    for (let i = 0; i < 256; i++) {
      imgData.data[i * 4 + 0] = lut.r[i];
      imgData.data[i * 4 + 1] = lut.g[i];
      imgData.data[i * 4 + 2] = lut.b[i];
      imgData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  }, [lut]);
  return (
    <canvas
      ref={canvasRef}
      width={256}
      height={1}
      style={{ width: "100%", height: 18, display: "block", imageRendering: "pixelated" }}
    />
  );
}

// ── グレースケールダミー LUT ─────────────────────────────────────

const GRAY_LUT: LutData = {
  name: "__gray__",
  r: Array.from({ length: 256 }, (_, i) => i),
  g: Array.from({ length: 256 }, (_, i) => i),
  b: Array.from({ length: 256 }, (_, i) => i),
};

// ── LutDialog ───────────────────────────────────────────────────

/**
 * LUT 選択ダイアログ。
 *
 * - 名前とカラーバーを並列表示したリストから選択する。
 * - 先頭に「グレースケール（リセット）」を常時表示する。
 * - onSelect(null)  → LUT リセット（グレースケール）
 * - onSelect(lut)   → 選択した LUT を適用
 */
export function LutDialog({
  currentLutName,
  onSelect,
  onClose,
}: {
  /** 現在適用中の LUT 名（null = グレースケール）。 */
  currentLutName: string | null;
  onSelect: (lut: LutData | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [names, setNames] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(currentLutName);
  /** ロード済み LUT データのキャッシュ（ダイアログ内スコープ）。 */
  const [lutCache, setLutCache] = useState<Map<string, LutData>>(new Map());
  const dialogRef = useRef<HTMLDivElement>(null);

  // LUT 名一覧をフェッチ
  useEffect(() => {
    fetchLutNames().then(setNames).catch(() => setNames([]));
  }, []);

  // スクロールして選択アイテムを表示
  useEffect(() => {
    if (selected) {
      const el = dialogRef.current?.querySelector(`[data-lut="${selected}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [names, selected]);

  // LUT データを遅延ロード（スクロール時/選択時）
  const loadLutIfNeeded = useCallback(
    (name: string) => {
      // グレースケール（リセット）行の番兵名はバックエンドに存在しない。
      // IntersectionObserver が data-lut="__gray__" を拾って fetch すると 404 になるため弾く。
      if (name === GRAY_LUT.name) return;
      if (lutCache.has(name)) return;
      fetchLutData(name)
        .then((data) => setLutCache((prev) => new Map(prev).set(name, data)))
        .catch(() => {});
    },
    [lutCache],
  );

  // 可視範囲内のアイテムを先読みロード（IntersectionObserver）
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listRef.current || !names) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const name = (entry.target as HTMLElement).dataset.lut;
            if (name) loadLutIfNeeded(name);
          }
        }
      },
      { root: listRef.current, threshold: 0 },
    );
    const items = listRef.current.querySelectorAll("[data-lut]");
    items.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [names, loadLutIfNeeded]);

  const handleApply = () => {
    if (selected === null) {
      onSelect(null);
    } else {
      const data = lutCache.get(selected) ?? null;
      if (data) {
        onSelect(data);
      } else {
        // まだロードされていなければロードして適用
        fetchLutData(selected)
          .then((d) => onSelect(d))
          .catch(() => onSelect(null));
      }
    }
    onClose();
  };

  // Esc キーで閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    // バックドロップ
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* ダイアログ本体 */}
      <div
        ref={dialogRef}
        data-testid="lut-dialog"
        style={{
          background: "#1e2530",
          border: "1px solid #3a4252",
          borderRadius: 8,
          padding: "16px 0 12px",
          width: 360,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
          color: "#e0e6f0",
        }}
      >
        {/* タイトル */}
        <div
          style={{
            padding: "0 16px 12px",
            fontWeight: 600,
            fontSize: 13,
            borderBottom: "1px solid #3a4252",
          }}
        >
          {t("viewer.lut.title")}
        </div>

        {/* LUT リスト */}
        <div
          ref={listRef}
          style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}
        >
          {names === null ? (
            <div style={{ padding: "12px 16px", color: "#8a9bb2", fontSize: 12 }}>
              {t("viewer.lut.loading")}
            </div>
          ) : (
            <>
              {/* グレースケール（リセット）行 */}
              <LutRow
                name={null}
                label={t("viewer.lut.none")}
                lut={GRAY_LUT}
                selected={selected === null}
                onSelect={() => setSelected(null)}
                onDoubleClick={() => { setSelected(null); onSelect(null); onClose(); }}
              />
              {/* LUT 一覧 */}
              {names.map((name) => (
                <LutRow
                  key={name}
                  name={name}
                  label={name.replace(/_/g, " ")}
                  lut={lutCache.get(name) ?? null}
                  selected={selected === name}
                  onSelect={() => { setSelected(name); loadLutIfNeeded(name); }}
                  onDoubleClick={() => {
                    const d = lutCache.get(name);
                    if (d) { onSelect(d); onClose(); }
                    else {
                      fetchLutData(name).then((dd) => { onSelect(dd); onClose(); }).catch(() => {});
                    }
                  }}
                />
              ))}
            </>
          )}
        </div>

        {/* ボタン行 */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 16px 0",
            borderTop: "1px solid #3a4252",
          }}
        >
          <button
            data-testid="lut-cancel-button"
            style={btnStyle}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            data-testid="lut-apply-button"
            style={{ ...btnStyle, background: "#0b5cad", color: "#fff", borderColor: "#0b5cad" }}
            onClick={handleApply}
          >
            {t("viewer.lut.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 行コンポーネント ─────────────────────────────────────────────

function LutRow({
  name,
  label,
  lut,
  selected,
  onSelect,
  onDoubleClick,
}: {
  name: string | null;
  label: string;
  lut: LutData | null;
  selected: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      data-lut={name ?? "__gray__"}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 14px",
        cursor: "pointer",
        background: selected ? "rgba(11,92,173,0.25)" : "transparent",
        borderLeft: selected ? "3px solid #0b5cad" : "3px solid transparent",
        transition: "background 0.1s",
        userSelect: "none",
      }}
    >
      {/* カラーバー */}
      <div
        style={{
          width: 120,
          flexShrink: 0,
          border: "1px solid #3a4252",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        {lut ? (
          <ColorBar lut={lut} />
        ) : (
          <div style={{ height: 18, background: "#2a3242" }} />
        )}
      </div>
      {/* 名前 */}
      <span
        style={{
          fontSize: 12,
          color: selected ? "#a8c8ff" : "#c0cad8",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── スタイル定数 ────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  padding: "5px 16px",
  fontSize: 12,
  borderRadius: 4,
  border: "1px solid #3a4252",
  background: "#2a3242",
  color: "#c0cad8",
  cursor: "pointer",
};
