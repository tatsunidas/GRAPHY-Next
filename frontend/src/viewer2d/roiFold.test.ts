import { describe, expect, it } from "vitest";
import { foldKey, isFolded, toggleFold } from "./roiFold";

describe("ROI マネージャの折りたたみ（ROI の一覧と Measurements の一覧は独立）", () => {
  const sec = "s:P1|1.2.3";

  it("Measurements 側を折りたたんでも、ROI 側の同じ見出しは変わらない", () => {
    const folded = toggleFold(new Set<string>(), foldKey("meas", sec));
    expect(isFolded(folded, "meas", sec)).toBe(true);
    expect(isFolded(folded, "roi", sec)).toBe(false);
  });

  it("ROI 側を折りたたんでも、Measurements 側は変わらない", () => {
    const folded = toggleFold(new Set<string>(), foldKey("roi", sec));
    expect(isFolded(folded, "roi", sec)).toBe(true);
    expect(isFolded(folded, "meas", sec)).toBe(false);
  });

  it("★ 負例: 鍵を共有する旧実装（種別なし）では、片方の操作がもう片方にも効く", () => {
    // 旧実装の再現: 鍵が見出しの鍵そのもの
    const legacy = toggleFold(new Set<string>(), sec);
    expect(legacy.has(sec)).toBe(true); // どちらの一覧から見ても同じ鍵 ＝ 連動していた
    // 新実装の鍵は、旧実装の鍵とは別物（旧の鍵では、新の判定は閉じない）
    expect(isFolded(legacy, "roi", sec)).toBe(false);
    expect(isFolded(legacy, "meas", sec)).toBe(false);
  });

  it("もう一度押すと開く。元の集合は変えない", () => {
    const a = new Set<string>();
    const b = toggleFold(a, foldKey("roi", sec));
    const c = toggleFold(b, foldKey("roi", sec));
    expect(a.size).toBe(0);
    expect(b.size).toBe(1);
    expect(c.size).toBe(0);
  });

  it("患者・グループの見出しでも、種別ごとに独立", () => {
    for (const s of ["p:P1", "g:grp-1"]) {
      const folded = toggleFold(new Set<string>(), foldKey("meas", s));
      expect(isFolded(folded, "roi", s)).toBe(false);
    }
  });
});
