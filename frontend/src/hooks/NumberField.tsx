/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 数値入力欄。**打っている最中は邪魔をせず、確定（blur / Enter）で範囲に収める**。
 *
 * <p>素の `<input type="number" value={n} onChange={e => set(Number(e.target.value))} />` は
 * キーボードで直しにくい。空にした瞬間 `Number("")` が 0 になって欄が "0" に書き換わり、
 * カーソルが飛んで「30 を 20 にしたいだけなのに打てない」状態になる。入力途中で min まで
 * 引き上げる実装も同じで、min=2 のときに "12" と打とうとすると最初の "1" が 2 に化ける。
 *
 * <p>そこで<b>表示テキストは自前で持ち</b>、
 * <ul>
 *   <li>入力中は文字列をそのまま保持し、数値として読めるときだけ親へ渡す（丸めも切り上げもしない）</li>
 *   <li>blur / Enter で min・max・step に収め、表示も揃える</li>
 *   <li>親が外から値を変えたとき（別の設定に連動して変わる等）だけ表示を追従させる</li>
 * </ul>
 */
import { useEffect, useState } from "react";

export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  style,
  title,
}: {
  value: number;
  /** 確定値（範囲内）。入力途中の値もそのまま来るので、送信前は親側で使う値をそのまま信用してよい。 */
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** 刻み。指定すると確定時に min（無ければ 0）からの倍数へ丸める（カーネル径の奇数など）。 */
  step?: number;
  disabled?: boolean;
  style?: React.CSSProperties;
  title?: string;
}) {
  const [text, setText] = useState(String(value));

  // 外から変わったときだけ追従する。自分が打っている最中は value === Number(text) なので触らない。
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    const raw = text.trim();
    const parsed = Number(raw);
    let v = raw === "" || !Number.isFinite(parsed) ? value : parsed;
    if (step && step > 0) {
      const base = min ?? 0;
      v = base + Math.round((v - base) / step) * step;
    }
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    setText(String(v));
    if (v !== value) onChange(v);
  };

  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      style={style}
      title={title}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        // 範囲へ丸めるのは確定時。ここで丸めると "12" の "1" が min に化ける。
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
