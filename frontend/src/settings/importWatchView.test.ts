/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { barView, canSave, errorKey, nextBaseline, formFromStatus, parseInterval, toSettings, type ImportWatchStatus } from "./importWatchView";

describe("importWatchView", () => {
  it("間隔は 1 以上の整数だけ受ける", () => {
    expect(parseInterval("5")).toBe(5);
    expect(parseInterval(" 30 ")).toBe(30);
    for (const bad of ["", "0", "-1", "1.5", "abc", "1e3", "９"]) expect(parseInterval(bad)).toBeNull();
  });

  it("有効にして保存するにはフォルダと間隔が要る。無効にするだけなら要らない", () => {
    expect(canSave({ enabled: true, folder: "/d", intervalSec: "5" })).toBe(true);
    expect(canSave({ enabled: true, folder: "", intervalSec: "5" })).toBe(false);
    expect(canSave({ enabled: true, folder: "  ", intervalSec: "5" })).toBe(false);
    expect(canSave({ enabled: true, folder: "/d", intervalSec: "" })).toBe(false);
    expect(canSave({ enabled: false, folder: "", intervalSec: "" })).toBe(true);
  });

  it("保存する設定は backend のキーで、不正な間隔は送らない", () => {
    expect(toSettings({ enabled: true, folder: " /d ", intervalSec: "7" })).toEqual({
      "import.watch.enabled": "true",
      "import.watch.folder": "/d",
      "import.watch.intervalSec": "7",
    });
    expect(toSettings({ enabled: false, folder: "", intervalSec: "x" })).toEqual({
      "import.watch.enabled": "false",
      "import.watch.folder": "",
    });
  });

  it("異常コードは対応する文言に、未知のコードは汎用の文言に", () => {
    expect(errorKey("folder-not-found")).toBe("importWatch.err.folder-not-found");
    expect(errorKey("folder-overlaps-db")).toBe("importWatch.err.folder-overlaps-db");
    expect(errorKey("something-new")).toBe("importWatch.err.unknown");
  });

  it("状態から入力欄の初期値を作る（未設定は空）", () => {
    const s = { enabled: false, folder: null, intervalSec: null } as unknown as ImportWatchStatus;
    expect(formFromStatus(s)).toEqual({ enabled: false, folder: "", intervalSec: "" });
  });

  const st = (o: Partial<ImportWatchStatus> = {}): ImportWatchStatus => ({
    enabled: true, folder: "/d", intervalSec: 5, scanning: false, lastScanAt: 1, waiting: 0, imported: 0,
    skipped: 0, failed: 0, error: null, failures: [], ...o,
  });

  it("基準は最初の応答で置き、開く前の取込では促さない", () => {
    expect(nextBaseline(null, null)).toBeNull();
    const b = nextBaseline(st({ imported: 7 }), null);
    expect(b).toBe(7);
    expect(barView(st({ imported: 7 }), b).newCount).toBe(0);
  });

  it("取込が基準より増えたときだけ新しい取り込みを数える", () => {
    expect(barView(st({ imported: 10 }), 7).newCount).toBe(3);
    expect(barView(st({ imported: 7 }), 7).newCount).toBe(0);
    expect(barView(st({ imported: 5 }), 7).newCount).toBe(0);
  });

  it("取込が基準より減ったら基準を引き直す（DB のリセットなど）", () => {
    expect(nextBaseline(st({ imported: 2 }), 7)).toBe(2);
    expect(nextBaseline(st({ imported: 9 }), 7)).toBe(7);
  });

  it("無効・未取得なら状態バーに出さない。異常は出す", () => {
    expect(barView(null, null).visible).toBe(false);
    expect(barView(st({ enabled: false, imported: 3 }), 0).visible).toBe(false);
    const v = barView(st({ error: "folder-not-found", waiting: 2, failed: 1 }), 0);
    expect(v).toMatchObject({ visible: true, error: "folder-not-found", waiting: 2, failed: 1 });
  });
});
