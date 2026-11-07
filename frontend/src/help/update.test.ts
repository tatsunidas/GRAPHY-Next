/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";
import {
  compareVersions, formatMegabytes, isUpdateActive, updateFailureKind, updateProgressPercent,
  type UpdateFailureKind,
} from "./update";
import { updateMenuLabel } from "./updateLabel";
import { __setUpdateStateForTest, getUpdateState } from "./updateState";

describe("updateFailureKind（main の理由コード → 利用者に見せる種類）", () => {
  it("ネットワーク断・無通信は network", () => {
    expect(updateFailureKind("network")).toBe("network");
    expect(updateFailureKind("stall")).toBe("network");
  });
  it("検証の失敗（SHA-256・サイズ・署名のどれも）は verify", () => {
    for (const r of ["digest-mismatch", "size-mismatch", "signature-bad-signature", "signature-unknown-key", "signature-trusted-comment-mismatch"]) {
      expect(updateFailureKind(r)).toBe("verify");
    }
  });
  it("取得できなかった（HTTP エラー・許可外のホスト・リダイレクトの輪）は server", () => {
    for (const r of ["http-404", "http-503", "bad-host", "bad-url", "too-many-redirects", "too-large"]) {
      expect(updateFailureKind(r)).toBe("server");
    }
  });
  it("未知・未設定は other（ネットワークや検証と取り違えない）", () => {
    for (const r of [undefined, "", "error", "busy", "unsupported", "http-abc", "network-ish"]) {
      expect(updateFailureKind(r)).toBe("other");
    }
  });
  it("どの種類にも、日本語・英語の表示文が両方ある（欠けると画面にキーがそのまま出る）", () => {
    const kinds: UpdateFailureKind[] = ["network", "verify", "server", "other"];
    for (const k of kinds) {
      expect(ja[`help.update.fail.${k}`], `ja ${k}`).toBeTruthy();
      expect(en[`help.update.fail.${k}`], `en ${k}`).toBeTruthy();
    }
  });
  it("自動更新で増やしたキーは ja と en で一致する", () => {
    const keys = (d: Record<string, string>) => Object.keys(d).filter((k) => k.startsWith("help.update")).sort();
    expect(keys(ja)).toEqual(keys(en));
  });
});

describe("進捗の表示", () => {
  it("updateProgressPercent: 切り捨て・範囲に丸める・総量不明は null", () => {
    expect(updateProgressPercent(0, 100)).toBe(0);
    expect(updateProgressPercent(50, 100)).toBe(50);
    expect(updateProgressPercent(99.9, 100)).toBe(99);
    expect(updateProgressPercent(150, 100)).toBe(100);
    expect(updateProgressPercent(-5, 100)).toBe(0);
    expect(updateProgressPercent(10, 0)).toBeNull();
    expect(updateProgressPercent(undefined, 100)).toBeNull();
    expect(updateProgressPercent(10, undefined)).toBeNull();
  });
  it("formatMegabytes", () => {
    expect(formatMegabytes(0)).toBe("0.0 MB");
    expect(formatMegabytes(1024 * 1024 * 223.9)).toBe("223.9 MB");
    expect(formatMegabytes(undefined)).toBe("—");
    expect(formatMegabytes(-1)).toBe("—");
    expect(formatMegabytes(NaN)).toBe("—");
  });
  it("isUpdateActive: 取得・検証・適用の間だけ（ready・failed は進行中ではない）", () => {
    expect(["downloading", "verifying", "applying"].every(isUpdateActive)).toBe(true);
    for (const p of ["idle", "ready", "failed", "cancelled", undefined]) expect(isUpdateActive(p)).toBe(false);
  });
});

describe("Help メニューの表示", () => {
  const t = (k: string, params?: Record<string, string>) => k === "help.update.menu.suffix" ? `（${params?.state}）` : ({
    "help.update.menu.downloading": "ダウンロード中", "help.update.menu.verifying": "確認中",
    "help.update.menu.pending": "終了時に更新", "help.update.menu.applying": "再起動して更新中",
  } as Record<string, string>)[k] ?? k;
  it("進行中・保留中は括弧で状態を添え、それ以外は元のまま", () => {
    expect(updateMenuLabel(t, "更新を確認", { phase: "downloading", bytes: 50, total: 200 })).toBe("更新を確認（ダウンロード中 25%）");
    expect(updateMenuLabel(t, "更新を確認", { phase: "downloading" })).toBe("更新を確認（ダウンロード中）");
    expect(updateMenuLabel(t, "更新を確認", { phase: "verifying" })).toBe("更新を確認（確認中）");
    expect(updateMenuLabel(t, "更新を確認", { phase: "ready" })).toBe("更新を確認（終了時に更新）");
    expect(updateMenuLabel(t, "更新を確認", { phase: "applying" })).toBe("更新を確認（再起動して更新中）");
    for (const phase of ["idle", "failed", "cancelled"] as const) expect(updateMenuLabel(t, "更新を確認", { phase })).toBe("更新を確認");
  });
});

describe("状態ストア（web 版では main が無いので idle のまま。通知で更新される）", () => {
  it("初期は idle。入れた状態が読める", () => {
    vi.stubGlobal("window", {}); // デスクトップのブリッジ（window.graphyDesktop）が無い環境＝web 版
    expect(getUpdateState().phase).toBe("idle");
    __setUpdateStateForTest({ phase: "ready", version: "9.9.9", mode: "onQuit" });
    expect(getUpdateState()).toEqual({ phase: "ready", version: "9.9.9", mode: "onQuit" });
    __setUpdateStateForTest({ phase: "idle" });
    vi.unstubAllGlobals();
  });
});

describe("compareVersions（既存。自動更新の対象判定の前提）", () => {
  it("新しい版・同じ版・古い版", () => {
    expect(compareVersions("0.6.2", "0.6.1")).toBe(1);
    expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.6.1", "0.6.1")).toBe(0);
    expect(compareVersions("0.6.0", "0.6.1")).toBe(-1);
  });
});
