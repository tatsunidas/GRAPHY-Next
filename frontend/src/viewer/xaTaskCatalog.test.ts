/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * タスク・ランチャーの一覧と可否判定（A13-2・`fw/angio-design.md` §21.2）。
 *
 * <p>ここで守りたいのは **「押せないカードが理由なしで並ばない」** ことと、
 * **理由の順序**（ユーザが今すぐ直せない理由を先に出す）。
 */
import { describe, expect, it } from "vitest";

import { ja } from "../i18n/ja";
import { en } from "../i18n/en";
import {
  ANALYSIS_TASKS,
  isXaModality,
  type LauncherContext,
  taskAvailability,
} from "./xaTaskCatalog";
import {
  XA_TASK_TTL_MS,
  isFreshRequest,
  matchesRequest,
  pendingXaTask,
  requestXaTask,
  resetXaTaskLaunch,
  type XaTaskRequest,
} from "./xaTaskLaunch";

const READY: LauncherContext = { hasStudy: true, seriesModality: "XA", standalone: true };

describe("ANALYSIS_TASKS", () => {
  it("id が重複しない", () => {
    const ids = ANALYSIS_TASKS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("🚨 実装済みのタスクは必ず開く先を持つ（押しても何も起きないカードを作らない）", () => {
    for (const d of ANALYSIS_TASKS) {
      if (d.implemented) expect(d.opens, d.id).not.toBeNull();
      else expect(d.opens, d.id).toBeNull();
    }
  });

  it("🚨 見出し・説明の i18n キーが ja / en 双方に存在する（CLAUDE.md ルール 5）", () => {
    const keys = ANALYSIS_TASKS.flatMap((d) => [d.labelKey, d.descKey]);
    for (const k of keys) {
      expect(ja, `ja: ${k}`).toHaveProperty(k);
      expect(en, `en: ${k}`).toHaveProperty(k);
    }
  });

  it("🚨 押せない理由の文言も ja / en 双方にある", () => {
    // 理由が引けないと、押せないカードが**空の理由**を出す（＝無言で押せないボタンに戻る）。
    const contexts: LauncherContext[] = [
      READY,
      { hasStudy: false, seriesModality: null, standalone: true },
      { hasStudy: true, seriesModality: "CT", standalone: true },
      { hasStudy: true, seriesModality: "XA", standalone: false },
    ];
    for (const ctx of contexts) {
      for (const d of ANALYSIS_TASKS) {
        const av = taskAvailability(d, ctx);
        if (av.enabled) continue;
        expect(av.reasonKey, d.id).toBeTruthy();
        expect(ja, `ja: ${av.reasonKey}`).toHaveProperty(av.reasonKey as string);
        expect(en, `en: ${av.reasonKey}`).toHaveProperty(av.reasonKey as string);
      }
    }
  });
});

describe("taskAvailability", () => {
  const qca = ANALYSIS_TASKS.find((d) => d.id === "qca")!;
  // 未実装タスクの代表（A5a・A6b を実装したので LV バイプレーンに持ち替えた）。
  const unimplemented = ANALYSIS_TASKS.find((d) => d.id === "qlvBiplane")!;
  const report = ANALYSIS_TASKS.find((d) => d.id === "report")!;

  it("実装済み・standalone・XA シリーズ選択済みなら押せる", () => {
    expect(taskAvailability(qca, READY).enabled).toBe(true);
  });

  it("🚨 未実装は他の条件が揃っていても押せない（フェーズ名を出す）", () => {
    const av = taskAvailability(unimplemented, READY);
    expect(av.enabled).toBe(false);
    expect(av.reasonKey).toBe("xa.task.reason.notImplemented");
    expect(av.params?.phase).toBe("A5c");
  });

  it("🚨 未実装かつスタディ未選択なら『未実装』を出す（直せない理由が先）", () => {
    // 「スタディを選べ」と出すと、選んでも状況が変わらず**バグに見える**。
    const av = taskAvailability(unimplemented, { hasStudy: false, seriesModality: null, standalone: true });
    expect(av.reasonKey).toBe("xa.task.reason.notImplemented");
  });

  it("web モードでは XA の解析タスクが落ちる（A12 未対応）", () => {
    const av = taskAvailability(qca, { ...READY, standalone: false });
    expect(av.enabled).toBe(false);
    expect(av.reasonKey).toBe("xa.task.reason.standaloneOnly");
  });

  it("XA 以外のシリーズを選んでいるときは理由を出す", () => {
    expect(taskAvailability(qca, { ...READY, seriesModality: "CT" }).reasonKey).toBe(
      "xa.task.reason.noXaSeries",
    );
    expect(taskAvailability(qca, { ...READY, seriesModality: null }).reasonKey).toBe(
      "xa.task.reason.noXaSeries",
    );
  });

  it("🔑 報告書はシリーズを要らず web でも押せる（スタディにだけ紐づく）", () => {
    expect(taskAvailability(report, { hasStudy: true, seriesModality: null, standalone: false }).enabled).toBe(true);
    expect(taskAvailability(report, { hasStudy: false, seriesModality: null, standalone: true }).enabled).toBe(false);
  });

  it("モダリティの大小文字は区別しない", () => {
    expect(isXaModality("xa")).toBe(true);
    expect(isXaModality("XRF")).toBe(true);
    expect(isXaModality("CT")).toBe(false);
    expect(isXaModality(null)).toBe(false);
  });
});

describe("xaTaskLaunch", () => {
  const req: XaTaskRequest = {
    id: "qca:1",
    target: "xaAnalysis",
    studyUid: "1.2.3",
    seriesUid: "1.2.3.4",
    at: 1_000_000,
  };

  it("🚨 宛先はスタディとシリーズの両方で判定する", () => {
    expect(matchesRequest(req, { studyUid: "1.2.3", seriesUid: "1.2.3.4" })).toBe(true);
    expect(matchesRequest(req, { studyUid: "9.9.9", seriesUid: "1.2.3.4" })).toBe(false);
    expect(matchesRequest(req, { studyUid: "1.2.3", seriesUid: "9.9.9" })).toBe(false);
  });

  it("🚨 古い依頼は引き取らない（後で開いたビューアにダイアログが降ってこない）", () => {
    expect(isFreshRequest(req, req.at)).toBe(true);
    expect(isFreshRequest(req, req.at + XA_TASK_TTL_MS)).toBe(true);
    expect(isFreshRequest(req, req.at + XA_TASK_TTL_MS + 1)).toBe(false);
  });

  it("🚨 発行より前の時刻も弾く（時計のずれで勝手に開かない）", () => {
    expect(isFreshRequest(req, req.at - 1)).toBe(false);
  });

  it("依頼は 1 つだけ保持する（連続で押したら新しいほうが正しい）", () => {
    resetXaTaskLaunch();
    requestXaTask(req);
    requestXaTask({ ...req, id: "qlv:2", target: "qlv" });
    expect(pendingXaTask()?.id).toBe("qlv:2");
    resetXaTaskLaunch();
    expect(pendingXaTask()).toBeNull();
  });
});
