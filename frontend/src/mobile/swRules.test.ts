/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canRegisterServiceWorker } from "./registerServiceWorker";

// public/sw-rules.js は SW が importScripts で読む素の JS。テストも同じファイルを評価する。
new Function(readFileSync(new URL("../../public/sw-rules.js", import.meta.url), "utf-8"))();
const { shouldCache, isShellNavigation } = (
  globalThis as unknown as {
    graphySwRules: {
      shouldCache: (url: string, method: string, origin: string, scope: string) => boolean;
      isShellNavigation: (url: string, scope: string) => boolean;
    };
  }
).graphySwRules;

const O = "https://pacs.example";
const cache = (path: string, method = "GET", scope = "/") => shouldCache(O + path, method, O, scope);

describe("SW のキャッシュ対象", () => {
  it("正例: アプリ本体（画面・資産・アイコン・manifest）は入る", () => {
    for (const p of ["/", "/index.html", "/assets/index-ab12.js", "/icons/app/GRAPHY-512.png", "/manifest.webmanifest"]) {
      expect(cache(p), p).toBe(true);
    }
  });
  it("負例: 患者データ・共有リンク・描画結果・その他は入らない", () => {
    for (const p of ["/api/studies", "/api/dicomweb/studies/1/series", "/s/abc123", "/rendered/x.mp4", "/sw.js", "/other"]) {
      expect(cache(p), p).toBe(false);
    }
  });
  it("負例: GET 以外・別オリジンは入らない", () => {
    expect(cache("/assets/a.js", "POST")).toBe(false);
    expect(shouldCache("https://evil.example/assets/a.js", "GET", O, "/")).toBe(false);
  });
  it("サブパス配備でもスコープ相対で判定する", () => {
    expect(cache("/graphy/assets/a.js", "GET", "/graphy/")).toBe(true);
    expect(cache("/graphy/api/studies", "GET", "/graphy/")).toBe(false);
    expect(cache("/assets/a.js", "GET", "/graphy/")).toBe(false);
  });
  it("画面遷移の対象はルートと index.html だけ（共有リンクは奪わない）", () => {
    expect(isShellNavigation(O + "/", "/")).toBe(true);
    expect(isShellNavigation(O + "/index.html", "/")).toBe(true);
    expect(isShellNavigation(O + "/s/abc", "/")).toBe(false);
  });
});

describe("SW を登録してよい環境", () => {
  it("http(s) で SW 対応なら登録する", () => {
    expect(canRegisterServiceWorker({ serviceWorker: {} }, "https:")).toBe(true);
    expect(canRegisterServiceWorker({ serviceWorker: {} }, "http:")).toBe(true);
  });
  it("Electron の file:// と SW 非対応は登録しない", () => {
    expect(canRegisterServiceWorker({ serviceWorker: {} }, "file:")).toBe(false);
    expect(canRegisterServiceWorker({}, "https:")).toBe(false);
  });
});
