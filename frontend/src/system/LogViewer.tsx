/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// System メニューの「Log」: log.ts のリングバッファに溜まった全ログを表示するフローティングパネル。
// 非モーダル（背後の操作は可能）。既に開いている場合は openLogViewer() で最前面へ（ViewTop）。
//
// App に <LogViewerHost /> を 1 つだけマウントし、各メニューは openLogViewer() を呼ぶだけでよい。

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import {
  clearLogEntries,
  getLogEntries,
  subscribeLog,
  type LogEntry,
  type LogLevel,
} from "../log";
import { startBackendLogPolling } from "./backendLog";

// ── モジュールレベルの開閉コントローラ（プロップ配線不要で任意のメニューから開ける）──
let openFn: (() => void) | null = null;

/** Log ビューアを開く（既に開いていれば最前面へ）。 */
export function openLogViewer(): void {
  openFn?.();
}

/** App に 1 つだけマウントするホスト。openLogViewer() を受けてダイアログを出す。 */
export function LogViewerHost() {
  const [open, setOpen] = useState(false);
  // openLogViewer() のたびにインクリメント → 最前面化＆最下部スクロールのトリガ。
  const [raise, setRaise] = useState(0);

  useEffect(() => {
    openFn = () => {
      setOpen(true);
      setRaise((r) => r + 1);
    };
    return () => {
      openFn = null;
    };
  }, []);

  if (!open) return null;
  return <LogViewerDialog raise={raise} onClose={() => setOpen(false)} />;
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "#8a97a4",
  info: "#2f7d32",
  warn: "#b8860b",
  error: "#c62828",
};

function ts2str(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function LogViewerDialog({ raise, onClose }: { raise: number; onClose: () => void }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<LogEntry[]>(() => getLogEntries());
  const [enabled, setEnabled] = useState<Record<LogLevel, boolean>>({
    debug: true,
    info: true,
    warn: true,
    error: true,
  });
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  // ドラッグ移動用の位置（null=初期の右下寄せ）。
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // 新規ログを購読（clearLogEntries の番兵 seq=-1 は全体を再取得）。
  useEffect(() => {
    return subscribeLog((e) => {
      if (e.seq < 0) setEntries(getLogEntries());
      else setEntries((prev) => [...prev, e]);
    });
  }, []);

  // 表示中だけバックエンド（DIMSE/DICOMweb 等）ログを取り込む。閉じると停止。
  useEffect(() => startBackendLogPolling(), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) => enabled[e.level] && (q === "" || e.text.toLowerCase().includes(q)),
    );
  }, [entries, enabled, query]);

  // 自動スクロール（新規ログ・フィルタ変更・ViewTop 時に最下部へ）。
  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [filtered, autoScroll, raise]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    const base = pos ?? { x: window.innerWidth - 720 - 24, y: 64 };
    drag.current = { dx: e.clientX - base.x, dy: e.clientY - base.y };
    const move = (ev: MouseEvent) => {
      if (!drag.current) return;
      setPos({ x: ev.clientX - drag.current.dx, y: ev.clientY - drag.current.dy });
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const copyAll = () => {
    const text = filtered
      .map((e) => `${ts2str(e.ts)} [${e.level.toUpperCase()}] ${e.text}`)
      .join("\n");
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  const panelStyle: React.CSSProperties = {
    ...panel,
    // raise を stacking に反映（他ダイアログより手前へ）。
    zIndex: 4000 + raise,
    ...(pos
      ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
      : { right: 24, top: 64 }),
  };

  return (
    <div style={panelStyle} role="dialog" aria-label={t("system.log")}>
      <div style={header} onMouseDown={onHeaderMouseDown}>
        <span style={{ fontWeight: 600 }}>{t("system.log")}</span>
        <span style={{ color: "#8a97a4", fontSize: 11 }}>
          {t("log.count", { shown: filtered.length, total: entries.length })}
        </span>
        <button style={closeBtn} onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
          ✕
        </button>
      </div>

      <div style={toolbar} onMouseDown={(e) => e.stopPropagation()}>
        {LEVELS.map((lv) => (
          <label key={lv} style={{ ...levelChip, color: LEVEL_COLOR[lv] }}>
            <input
              type="checkbox"
              checked={enabled[lv]}
              onChange={(e) => setEnabled((prev) => ({ ...prev, [lv]: e.target.checked }))}
            />
            {lv.toUpperCase()}
          </label>
        ))}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("common.search")}
          style={searchInput}
        />
        <label style={autoLabel}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          {t("log.autoscroll")}
        </label>
        <button style={smallBtn} onClick={copyAll}>{t("log.copy")}</button>
        <button style={smallBtn} onClick={() => clearLogEntries()}>{t("log.clear")}</button>
      </div>

      <div ref={bodyRef} style={body}>
        {filtered.length === 0 ? (
          <div style={{ color: "#8a97a4", padding: 12 }}>{t("log.empty")}</div>
        ) : (
          filtered.map((e) => (
            <div key={e.seq} style={row}>
              <span style={{ color: "#9aa5b1" }}>{ts2str(e.ts)}</span>
              <span style={{ color: LEVEL_COLOR[e.level], fontWeight: 600, minWidth: 44, display: "inline-block" }}>
                {e.level.toUpperCase()}
              </span>
              <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "fixed",
  width: 720,
  maxWidth: "90vw",
  height: 460,
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  background: "#fff",
  border: "1px solid #cfd6de",
  borderRadius: 8,
  boxShadow: "0 10px 40px rgba(0,0,0,0.28)",
  fontFamily: "system-ui, sans-serif",
  fontSize: 12,
  overflow: "hidden",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  background: "#0b2a45",
  color: "#fff",
  cursor: "move",
  userSelect: "none",
};
const closeBtn: React.CSSProperties = {
  marginLeft: "auto",
  border: "none",
  background: "transparent",
  color: "#dbe6f0",
  cursor: "pointer",
  fontSize: 14,
};
const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 12px",
  borderBottom: "1px solid #e6eaee",
  background: "#f6f8fa",
  flexWrap: "wrap",
};
const levelChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
const searchInput: React.CSSProperties = {
  flex: 1,
  minWidth: 100,
  border: "1px solid #cdd5de",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 12,
};
const autoLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 11,
  color: "#465563",
  cursor: "pointer",
};
const smallBtn: React.CSSProperties = {
  border: "1px solid #cdd5de",
  borderRadius: 5,
  background: "#fff",
  cursor: "pointer",
  fontSize: 11,
  padding: "3px 10px",
};
const body: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "6px 10px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  lineHeight: 1.5,
  background: "#fff",
};
const row: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "1px 0",
  borderBottom: "1px solid #f2f4f7",
};
