/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";

import { extractCalibrations, parseStored, serialize } from "./xaCalibrationStorage";

describe("XA 校正の永続化 — 直列化", () => {
  it("往復できる", () => {
    const raw = serialize({ mmPerPx: 0.208, method: "catheter", note: "6Fr" }, "2026-08-23T00:00:00Z");
    expect(parseStored(raw)).toEqual({ mmPerPx: 0.208, method: "catheter", note: "6Fr" });
  });

  it("★壊れた値・別版は黙って使わない（校正は数値の意味を変える）", () => {
    expect(parseStored("")).toBeNull();
    expect(parseStored("{")).toBeNull();
    expect(parseStored(JSON.stringify({ v: 2, mmPerPx: 0.2, method: "catheter" }))).toBeNull();
    expect(parseStored(JSON.stringify({ v: 1, mmPerPx: 0, method: "catheter" }))).toBeNull();
    expect(parseStored(JSON.stringify({ v: 1, mmPerPx: -1, method: "catheter" }))).toBeNull();
    expect(parseStored(JSON.stringify({ v: 1, mmPerPx: "x", method: "catheter" }))).toBeNull();
    // 知らない出自は使わない（"gsps" / "catheter" / "ruler" 以外）。
    expect(parseStored(JSON.stringify({ v: 1, mmPerPx: 0.2, method: "guess" }))).toBeNull();
  });

  it("GSPS 由来の出自を保つ（人の校正と混ぜない）", () => {
    const raw = serialize({ mmPerPx: 0.225, method: "gsps" }, "2026-08-23T00:00:00Z");
    expect(parseStored(raw)?.method).toBe("gsps");
  });
});

describe("XA 校正の永続化 — 設定マップからの取り出し", () => {
  it("プレフィックスの付いたキーだけ拾う", () => {
    const map = {
      "general.debugMode": "true",
      "xa.calibration.1.2.3": JSON.stringify({ v: 1, mmPerPx: 0.208, method: "catheter" }),
      "xa.calibration.1.2.4": JSON.stringify({ v: 1, mmPerPx: 0.3, method: "ruler" }),
      "viewer.wlPresets": "[]",
    };
    const got = extractCalibrations(map);
    expect([...got.keys()].sort()).toEqual(["1.2.3", "1.2.4"]);
    expect(got.get("1.2.3")?.mmPerPx).toBeCloseTo(0.208, 9);
  });

  it("★解除（空文字）は「校正あり」にしない", () => {
    // 設定ストアに削除 API が無いので空文字で上書きしている。ここを拾うと
    // 「消したはずの校正が次に開いたとき戻る」になる。
    const got = extractCalibrations({ "xa.calibration.1.2.3": "" });
    expect(got.size).toBe(0);
  });

  it("壊れた 1 件が他を巻き添えにしない", () => {
    const got = extractCalibrations({
      "xa.calibration.1.2.3": "{{{",
      "xa.calibration.1.2.4": JSON.stringify({ v: 1, mmPerPx: 0.3, method: "ruler" }),
    });
    expect([...got.keys()]).toEqual(["1.2.4"]);
  });
});
