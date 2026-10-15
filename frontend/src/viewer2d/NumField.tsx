/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState, type CSSProperties } from "react";

/**
 * 数値入力（下書きを持ち、Enter/フォーカスアウトで確定。不正入力は元へ戻す）。
 * 表示の文字列が `format(value)` から変わっていないときは確定しない
 * （丸めた表示値で元の値を上書きしないため）。
 */
export function NumField({ value, onCommit, testid, title, style, format }: {
  value: number;
  onCommit: (v: number) => void;
  testid: string;
  title?: string;
  style?: CSSProperties;
  format?: (v: number) => string;
}) {
  const fmt = format ?? ((v: number) => String(v));
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = () => {
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v)) { setText(fmt(value)); return; }
    if (text !== fmt(value)) onCommit(v);
  };
  return (
    <input
      type="number"
      step="any"
      data-testid={testid}
      value={text}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") { apply(); (e.target as HTMLInputElement).blur(); } }}
      onBlur={apply}
      style={style}
    />
  );
}
