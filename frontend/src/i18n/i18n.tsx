/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { ja } from "./ja";
import { en } from "./en";

export type Locale = "ja" | "en";

const DICTS: Record<Locale, Record<string, string>> = { ja, en };
const STORAGE_KEY = "graphy.locale";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitial(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    // localStorage 不可環境はブラウザ言語にフォールバック
  }
  return typeof navigator !== "undefined" && navigator.language.startsWith("en") ? "en" : "ja";
}

/** 辞書引き＋`{{var}}` 差し込み。純関数（辞書は const）。 */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[locale][key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
  }
  return s;
}

/**
 * **React の外**から使う翻訳。ロケールは `I18nProvider` と同じ localStorage から読む。
 *
 * <p>Cornerstone のツール（`getTextLines` など）は React のツリーの外で呼ばれるため
 * {@link useI18n} を使えない。**React の中では必ず {@link useI18n} を使うこと**
 * ——こちらはロケール変更で再レンダリングされない。
 */
export const tOutsideReact: TFn = (key, vars) => translate(detectInitial(), key, vars);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitial);

  const setLocale = (l: Locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // 保存不可でも状態は更新する
    }
    setLocaleState(l);
  };

  const t: TFn = (key, vars) => translate(locale, key, vars);

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}
