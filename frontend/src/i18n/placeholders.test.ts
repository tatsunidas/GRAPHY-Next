/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 訳文のプレースホルダが実際に置換される書き方になっていることの回帰テスト。
 *
 * <p>{@code t()} が置換するのは <b>二重</b>波括弧 {@code {{name}}} だけで、一重の
 * {@code {name}} はそのまま画面に出る。型でも lint でも捕まらず、その訳文を出す画面を
 * 実際に開くまで気づけない — GLAM の実機検証で「スライス {done}/{total}」と表示されて
 * 初めて見つかり、同じ書き間違いが 3D ビューアの 2 か所にも前から残っていた。
 */
import { describe, expect, it } from "vitest";
import { ja } from "./ja";
import { en } from "./en";

/** 二重波括弧に挟まれていない {name} を拾う。 */
const SINGLE_BRACE = /(?<!\{)\{([A-Za-z][A-Za-z0-9_]*)\}(?!\})/g;

const LOCALES: Array<[string, Record<string, string>]> = [
  ["ja", ja as Record<string, string>],
  ["en", en as Record<string, string>],
];

describe("i18n のプレースホルダ", () => {
  for (const [name, dict] of LOCALES) {
    it(`${name}: 置換されない一重波括弧を含まない`, () => {
      const offenders: string[] = [];
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value !== "string") continue;
        const found = value.match(SINGLE_BRACE);
        if (found) offenders.push(`${key}: ${found.join(", ")} → {{...}} と書くこと`);
      }
      expect(offenders).toEqual([]);
    });
  }

  it("ja と en が同じキー集合を持つ", () => {
    // 片方だけに訳を足すのはレビュー差し戻し対象（CLAUDE.md ルール 5）なので、ここでも押さえる。
    const jaKeys = Object.keys(ja as Record<string, string>).sort();
    const enKeys = Object.keys(en as Record<string, string>).sort();
    const onlyJa = jaKeys.filter((k) => !enKeys.includes(k));
    const onlyEn = enKeys.filter((k) => !jaKeys.includes(k));
    expect({ onlyJa, onlyEn }).toEqual({ onlyJa: [], onlyEn: [] });
  });

  it("同じキーの ja と en は同じプレースホルダを使う", () => {
    const jaDict = ja as Record<string, string>;
    const enDict = en as Record<string, string>;
    const names = (s: string) => (s.match(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g) ?? []).sort();
    const mismatched: string[] = [];
    for (const key of Object.keys(jaDict)) {
      if (typeof jaDict[key] !== "string" || typeof enDict[key] !== "string") continue;
      const a = names(jaDict[key]);
      const b = names(enDict[key]);
      if (a.join(",") !== b.join(",")) mismatched.push(`${key}: ja=[${a}] en=[${b}]`);
    }
    expect(mismatched).toEqual([]);
  });
});
