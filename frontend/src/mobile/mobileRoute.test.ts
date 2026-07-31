/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import {
  isMobileRoute,
  mobileHash,
  parentView,
  parseMobileRoute,
  type MobileView,
} from "./mobileRoute";

describe("isMobileRoute", () => {
  it("#mobile とそのサブパスだけを拾う", () => {
    expect(isMobileRoute("#mobile")).toBe(true);
    expect(isMobileRoute("mobile")).toBe(true); // `#` 無しでも可
    expect(isMobileRoute("#mobile/series")).toBe(true);
  });

  it("既存の別ウィンドウルートとは衝突しない", () => {
    expect(isMobileRoute("")).toBe(false);
    expect(isMobileRoute("#2dviewer")).toBe(false);
    expect(isMobileRoute("#mpr")).toBe(false);
    expect(isMobileRoute("#monitorqc")).toBe(false);
    // 前方一致だけで判定すると誤爆する紛らわしい名前。
    expect(isMobileRoute("#mobilex")).toBe(false);
  });
});

describe("parseMobileRoute", () => {
  it("ルートは studies", () => {
    expect(parseMobileRoute("#mobile")).toBe("studies");
    expect(parseMobileRoute("#mobile/")).toBe("studies");
  });

  it("サブパスを画面に対応づける", () => {
    expect(parseMobileRoute("#mobile/series")).toBe("series");
    expect(parseMobileRoute("#mobile/viewer")).toBe("viewer");
    expect(parseMobileRoute("#mobile/report")).toBe("report");
  });

  it("未知のサブパスは studies に倒す（壊れた URL で白画面にしない）", () => {
    expect(parseMobileRoute("#mobile/nope")).toBe("studies");
  });

  it("モバイルルートでなければ null", () => {
    expect(parseMobileRoute("")).toBe(null);
    expect(parseMobileRoute("#2dviewer")).toBe(null);
  });
});

describe("mobileHash", () => {
  it("parseMobileRoute と往復する", () => {
    const views: MobileView[] = ["studies", "series", "viewer", "report"];
    for (const v of views) {
      expect(parseMobileRoute(mobileHash(v))).toBe(v);
    }
  });

  it("root は #mobile（余計なスラッシュを付けない）", () => {
    expect(mobileHash("studies")).toBe("#mobile");
    expect(mobileHash("series")).toBe("#mobile/series");
  });
});

describe("parentView", () => {
  it("スタックの親を返す", () => {
    expect(parentView("report")).toBe("viewer");
    expect(parentView("viewer")).toBe("series");
    expect(parentView("series")).toBe("studies");
  });

  it("root には親が無い（戻るボタンを出さない判定に使う）", () => {
    expect(parentView("studies")).toBe(null);
  });
});
