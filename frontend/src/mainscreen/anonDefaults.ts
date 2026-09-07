/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { AnonOption } from "../api";

/** Anonymizer ダイアログの「除去（Clean）」列。既定はすべて OFF。 */
export const CLEAN_OPTS: AnonOption[] = [
  "CleanPixelData", "CleanRecognizableVisualFeatures", "CleanGraphics",
  "CleanStructuredContent", "CleanDescriptors",
];

/** Anonymizer ダイアログの「保持（Retain）」列。 */
export const RETAIN_OPTS: AnonOption[] = [
  "RetainUIDs", "RetainSafePrivate", "RetainDeviceIdentity", "RetainInstitutionIdentity",
  "RetainPatientCharacteristics", "RetainLongitudinalTemporalInformationFullDates",
  "RetainLongitudinalTemporalInformationModifiedDates",
];

/**
 * ダイアログを開いたときの既定オプション＝**Retain 系は既定 ON**（2026-08-20・ユーザー指定）。
 *
 * 意図は「まず情報を落とさない側から始めて、必要なぶんだけ外す」。素の PS3.15 Basic Profile は
 * 装置・施設・患者特性・日付・UID をすべて落とすため、研究用途では毎回チェックし直す手間になっていた。
 *
 * 🔴 **日付の 2 つは排他なので `ModifiedDates` は既定から外す。**
 * PS3.15 では Full Dates（原本の日付を保持）と Modified Dates（関係を保ったまま加工）は
 * どちらか一方を選ぶもので、UI は両方 ON にできてしまう。エンジンの
 * `AnonymizeConfig.getActionByOptionsAndDefault()` は**加工(C)を保持(K)より優先する**（安全側の設計）ため、
 * 両方 ON にすると ModifiedDates の C が勝つ。実測（2026-08-20）:
 *
 * | | StudyDate | StudyTime |
 * | :- | :- | :- |
 * | 元データ | `20260101` | `101530` |
 * | FullDates のみ ON（＝この既定） | `20260101` | `101530` |
 * | 両方 ON | **`20000101`** | **`000000`** |
 *
 * つまり両方 ON は「保持」どころか日付を潰す。しかも現状の C は VR 別の固定ダミーを返すだけで
 * 前後関係も保たないため、ModifiedDates 自体に不具合がある（`fw/mainscreen-tools.md` の Anonymizer §）。
 */
export const DEFAULT_ANON_OPTIONS: AnonOption[] = RETAIN_OPTS.filter(
  (o) => o !== "RetainLongitudinalTemporalInformationModifiedDates",
);

/**
 * 排他になっている日付オプションの組。PS3.15 では Full Dates（原本の日付を保持）と
 * Modified Dates（前後関係を保ったままシフト）は**どちらか一方**を選ぶ。
 */
export const DATE_OPTS: AnonOption[] = [
  "RetainLongitudinalTemporalInformationFullDates",
  "RetainLongitudinalTemporalInformationModifiedDates",
];

/**
 * オプションを 1 つトグルする。**日付の 2 つだけは相互排他**（片方を ON にすると他方を OFF）。
 *
 * 🔴 チェックボックスの見た目のままラジオ的に振る舞わせる。**radio にはしない** ——
 * 「両方 OFF」は有効な選択（＝Basic Profile の日付削除）だから。
 *
 * ⚠ backend 側（`AnonymizeController.validateDateOptions`）が正本で、両方 ON は 400 で弾かれる。
 * ここは「そもそも両方 ON にできない」ようにして、利用者が 400 を踏まないようにするための層。
 * プロファイルの読み込みは任意の JSON から options を丸ごと差し替えるので、UI だけでは塞げない。
 *
 * ⚠ 純関数として切り出してあるのは、vitest の include が `.ts` だけで **`.tsx` を見ない**ため。
 * ダイアログの中に書くとテストできない。
 */
export function toggleAnonOption(current: Set<AnonOption>, opt: AnonOption): Set<AnonOption> {
  const next = new Set(current);
  if (next.has(opt)) {
    next.delete(opt);
    return next;
  }
  next.add(opt);
  if (DATE_OPTS.includes(opt)) {
    for (const other of DATE_OPTS) {
      if (other !== opt) next.delete(other);
    }
  }
  return next;
}

/**
 * 外部から来たオプション集合（プロファイル JSON・保存済みプロファイル）を、排他規則に合わせて直す。
 *
 * <p>両方の日付オプションが入っていたら **ModifiedDates を落とす**（既定と同じ側＝
 * 「原本の日付を保持」を残す）。両方 ON のまま送っても backend が 400 で弾くので、
 * ここで直しておかないと利用者は「読み込んだのに実行できない」状態になる。
 *
 * @returns 直した集合と、落としたオプション（0 件なら何も直していない）
 */
export function sanitizeAnonOptions(opts: AnonOption[]): { options: Set<AnonOption>; dropped: AnonOption[] } {
  const set = new Set(opts);
  const dropped: AnonOption[] = [];
  if (DATE_OPTS.every((o) => set.has(o))) {
    const drop: AnonOption = "RetainLongitudinalTemporalInformationModifiedDates";
    set.delete(drop);
    dropped.push(drop);
  }
  return { options: set, dropped };
}
