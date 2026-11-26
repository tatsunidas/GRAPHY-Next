/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ダイアログの背景（暗い部分）を押したら閉じる、の安全な書き方。
 *
 * <p>背景に素の `onClick={onClose}` を付けると、**入力欄の中で押してテキストを選択し、ダイアログの外で
 * 離した**ときも `click` が（押した場所と離した場所の共通の祖先＝）背景に届いて閉じる。入力中の
 * 値が保存されないまま消える。**押したのも離したのも背景のときだけ**閉じる。
 *
 * 使い方: `<div style={backdrop} {...backdropClose(onClose)}>`
 */
import type { MouseEvent } from "react";

/** 直近の mousedown が、背景そのもの（子ではない）に落ちたか。マウスは 1 つなので共有でよい。 */
let downOnBackdrop = false;

export function backdropClose(onClose: () => void): {
  onMouseDown: (e: MouseEvent<HTMLElement>) => void;
  onClick: (e: MouseEvent<HTMLElement>) => void;
} {
  return {
    onMouseDown: (e) => {
      downOnBackdrop = e.target === e.currentTarget;
    },
    onClick: (e) => {
      const ok = downOnBackdrop && e.target === e.currentTarget;
      downOnBackdrop = false;
      if (ok) onClose();
    },
  };
}
