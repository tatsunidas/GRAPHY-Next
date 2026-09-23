/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 進捗バー。**分数が分かるときは determinate、分からないときは流れる帯**にする。
 *
 * <p>🔴 実機で「DSA を入れてから、また Diagnose を押してから、動いているのか
 * フリーズしているのか分からない」と言われた（§6.16）。段によっては総数が分からない
 * ——Worker の中の 1 回の呼び出しなど——ので、**分からないことを 0% と偽らず**、
 * 流れる帯で「動いている」ことだけを伝える。
 */
import React from "react";

const PROGRESS_CSS = `
@keyframes graphyIndet {
  0%   { transform: translateX(-110%); }
  100% { transform: translateX(260%); }
}
`;

export function ProgressBar({
  done,
  total,
  testId,
  width = 90,
  color = "#c08a30",
}: {
  done?: number;
  total?: number;
  testId?: string;
  width?: number;
  color?: string;
}) {
  const determinate = total != null && total > 0 && done != null;
  const pct = determinate ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
  const bar: React.CSSProperties = determinate
    ? { display: "block", height: "100%", width: `${pct}%`, background: color, transition: "width .15s linear" }
    : { display: "block", height: "100%", width: "40%", background: color, animation: "graphyIndet 1.1s ease-in-out infinite" };
  return (
    <span
      data-testid={testId}
      role="progressbar"
      aria-busy="true"
      {...(determinate
        ? { "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 }
        : {})}
      title={determinate ? `${done}/${total}` : undefined}
      style={{
        display: "inline-block",
        position: "relative",
        width,
        height: 6,
        borderRadius: 3,
        background: "rgba(128,128,128,0.25)",
        overflow: "hidden",
        verticalAlign: "middle",
        // 🚨 パネルは flex 列なので、これが無いと潰れる（§6.14.3 と同じ罠）。
        flexShrink: 0,
      }}
    >
      <style>{PROGRESS_CSS}</style>
      <span style={bar} />
    </span>
  );
}
