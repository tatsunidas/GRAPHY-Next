// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 一覧の自動更新の DOM の煙テスト: 実際に描画し、フック（問い合わせ → 判定）と状態バーの通知ボタンを通す。
// 本体の API は fetch の偽物で渡す。既定のまま（番号が動かない）では何も起きないことも見る。
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { StatusBar } from "./StatusBar";
import { useStoreVersion } from "./useStoreVersion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let version: number;
let host: HTMLElement;
let root: Root;
let reloads: number;
let latest: { notify: boolean; acknowledge: () => void } | null;

function Harness({ idle }: { idle: boolean }) {
  const r = useStoreVersion({ active: true, idle, onAutoReload: () => { reloads++; } });
  latest = r;
  return createElement("div", { "data-testid": "notify" }, String(r.notify));
}

async function render(idle: boolean) {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(Harness, { idle })));
  });
}

async function tick(ms = 3100) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  version = 5;
  reloads = 0;
  latest = null;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ version, changedAt: 1 }), { status: 200, headers: { "content-type": "application/json" } }))));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useStoreVersion（実際に描画して動かす）", () => {
  it("既定のまま（番号が動かない）なら、読み直しも通知も起きない", async () => {
    await render(true);
    await tick();
    await tick();
    expect(reloads).toBe(0);
    expect(host.querySelector('[data-testid="notify"]')!.textContent).toBe("false");
  });

  it("待機中に番号が進み、落ち着いたら自動で 1 回だけ読み直す（通知は出ない）", async () => {
    await render(true);
    await tick(); // 基準 = 5
    version = 8;
    await tick(); // 進んだ直後（まだ動いているかもしれない）
    expect(reloads).toBe(0);
    await tick(); // 同じ番号 → 落ち着いた
    expect(reloads).toBe(1);
    await tick();
    expect(reloads).toBe(1); // 基準が進んだので、繰り返さない
    expect(host.querySelector('[data-testid="notify"]')!.textContent).toBe("false");
  });

  it("負例: 操作中は読み直さず、通知を出す。押して読み直したら通知が消える", async () => {
    await render(false);
    await tick();
    version = 8;
    await tick();
    expect(reloads).toBe(0);
    expect(host.querySelector('[data-testid="notify"]')!.textContent).toBe("true");
    await act(async () => latest!.acknowledge()); // 手動の［更新］
    expect(host.querySelector('[data-testid="notify"]')!.textContent).toBe("false");
    await tick();
    expect(host.querySelector('[data-testid="notify"]')!.textContent).toBe("false");
  });
});

describe("StatusBar の通知ボタン", () => {
  async function bar(props: { storeChanged?: boolean; newCount?: number }) {
    const onReload = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          null,
          createElement(StatusBar, {
            status: null,
            error: null,
            storeChanged: props.storeChanged,
            importWatch: props.newCount
              ? { visible: true, error: null, imported: 3, waiting: 0, failed: 0, held: 0, newCount: props.newCount }
              : undefined,
            onReloadList: onReload,
          }),
        ),
      );
    });
    return onReload;
  }

  it("storeChanged のときだけボタンが出て、押すと読み直しが呼ばれる", async () => {
    const off = await bar({ storeChanged: false });
    expect(host.querySelector('[data-testid="statusbar-store-changed"]')).toBeNull();
    expect(off).not.toHaveBeenCalled();
    const on = await bar({ storeChanged: true });
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="statusbar-store-changed"]');
    expect(btn).not.toBeNull();
    await act(async () => btn!.click());
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("負例: 監視フォルダの「新しい取り込み」ボタンが出ているときは、二重に出さない", async () => {
    await bar({ storeChanged: true, newCount: 2 });
    expect(host.querySelector('[data-testid="statusbar-import-watch-new"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="statusbar-store-changed"]')).toBeNull();
  });
});
