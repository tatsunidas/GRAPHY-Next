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
