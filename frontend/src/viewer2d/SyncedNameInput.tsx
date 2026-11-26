/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, type CSSProperties, type MouseEventHandler } from "react";

/**
 * ROI マネージャの行の名前欄。
 *
 * 素の `defaultValue` の入力欄は、**再描画されても画面の文字が更新されない**（React は初期値しか見ない）。
 * 属性編集ダイアログ（✎）や他の経路で名前（メタ）を変えても、行の名前だけ古いまま残っていた。
 * ここでは、**入力中でないとき**だけ、渡された名前に画面の文字を合わせる（打っている最中の文字は上書きしない）。
 */
export function SyncedNameInput({
  value,
  onValueChange,
  style,
  title,
  onClick,
}: {
  value: string;
  onValueChange: (v: string) => void;
  style?: CSSProperties;
  title?: string;
  onClick?: MouseEventHandler<HTMLInputElement>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.value !== value) el.value = value;
  }, [value]);
  return (
    <input
      ref={ref}
      type="text"
      style={style}
      title={title}
      defaultValue={value}
      onClick={onClick}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
}
