/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../settings/settingsApi", () => ({ saveSettings: vi.fn(() => Promise.resolve({})) }));

import {
  DEFAULT_ROI_STATS_DISPLAY,
  getRoiStatsDisplay,
  parseRoiStatsDisplay,
  setRoiStatsDisplay,
  subscribeRoiStatsDisplay,
} from "./roiStatsDisplay";

beforeEach(() => {
  setRoiStatsDisplay(DEFAULT_ROI_STATS_DISPLAY);
});

describe("parseRoiStatsDisplay", () => {
  it("既定は「ROI の脇 / 要約 / 全 ROI」＝今までと同じ見え方", () => {
    expect(DEFAULT_ROI_STATS_DISPLAY).toEqual({ placement: "beside", detail: "compact", selectedOnly: false });
    expect(parseRoiStatsDisplay(undefined)).toEqual(DEFAULT_ROI_STATS_DISPLAY);
    expect(parseRoiStatsDisplay({})).toEqual(DEFAULT_ROI_STATS_DISPLAY);
  });

  it("設定値を解釈する", () => {
    expect(
      parseRoiStatsDisplay({
        "roi.statsPlacement": "corner",
        "roi.statsDetail": "full",
        "roi.statsSelectedOnly": "true",
      }),
    ).toEqual({ placement: "corner", detail: "full", selectedOnly: true });
  });

  it("未知の値は既定へ落とす（表示が壊れて何も出ない、を避ける）", () => {
    expect(
      parseRoiStatsDisplay({ "roi.statsPlacement": "somewhere", "roi.statsDetail": "everything" }),
    ).toEqual(DEFAULT_ROI_STATS_DISPLAY);
  });

  it("boolean は \"true\" / \"1\" を真とする", () => {
    expect(parseRoiStatsDisplay({ "roi.statsSelectedOnly": "1" }).selectedOnly).toBe(true);
    expect(parseRoiStatsDisplay({ "roi.statsSelectedOnly": "false" }).selectedOnly).toBe(false);
  });
});

describe("ランタイム状態", () => {
  it("部分更新でマージされる（3 軸は独立）", () => {
    setRoiStatsDisplay({ detail: "full" });
    expect(getRoiStatsDisplay()).toEqual({ placement: "beside", detail: "full", selectedOnly: false });
    setRoiStatsDisplay({ placement: "off" });
    expect(getRoiStatsDisplay()).toEqual({ placement: "off", detail: "full", selectedOnly: false });
  });

  it("変化が無ければ通知しない（描き直しを無駄に走らせない）", () => {
    let calls = 0;
    const off = subscribeRoiStatsDisplay(() => calls++);
    setRoiStatsDisplay({ placement: "beside" }); // 既定と同じ
    expect(calls).toBe(0);
    setRoiStatsDisplay({ placement: "corner" });
    expect(calls).toBe(1);
    off();
    setRoiStatsDisplay({ placement: "off" });
    expect(calls).toBe(1);
  });

  it("1 つの購読者が投げても他へ伝わる", () => {
    let reached = false;
    const off1 = subscribeRoiStatsDisplay(() => {
      throw new Error("boom");
    });
    const off2 = subscribeRoiStatsDisplay(() => {
      reached = true;
    });
    setRoiStatsDisplay({ placement: "corner" });
    expect(reached).toBe(true);
    off1();
    off2();
  });
});
