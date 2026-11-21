// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 検索パネルの日付の DOM の煙テスト。数日起動したまま日付がまたがる状況を、システム時刻を進めて再現する。
// 本体の API（設定）は fetch の偽物で渡し、期間は既定のまま（操作しない）で通す経路も含む。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import type { StudyFilters } from "../api";
import { SearchPanel } from "./SearchPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let searches: StudyFilters[];

const dates = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="date"]')).map((i) => i.value);
const button = (re: RegExp) => Array.from(host.querySelectorAll("button")).find((b) => re.test(b.textContent ?? ""))!;
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const lastSearch = () => searches[searches.length - 1];
function typeInto(el: HTMLInputElement, v: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 10, 18, 9, 0)); // 起動日 11/18
  searches = [];
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(SearchPanel, { onSearch: (f: StudyFilters) => searches.push(f) })));
  });
  await advance(300);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SearchPanel の日付", () => {
  it("起動日の今日で検索している（前提）", () => {
    expect(dates()).toEqual(["2026-11-18", "2026-11-18"]);
    expect(lastSearch()).toMatchObject({ studyDateFrom: "20261118", studyDateTo: "20261118" });
  });

  it("数日後に［今日］を押すと、起動日ではなくその日の今日で検索する", async () => {
    vi.setSystemTime(new Date(2026, 10, 22, 9, 0)); // タイマーは進めない（ボタン単体の検査）
    await act(async () => { button(/今日|Today/).click(); });
    expect(lastSearch()).toMatchObject({ studyDateFrom: "20261122", studyDateTo: "20261122" });
    expect(dates()).toEqual(["2026-11-22", "2026-11-22"]);
  });

  it("［1週間］も押した日が終わりになる", async () => {
    vi.setSystemTime(new Date(2026, 10, 22, 9, 0));
    await act(async () => { button(/1週間|Week|7/).click(); });
    expect(lastSearch()).toMatchObject({ studyDateFrom: "20261116", studyDateTo: "20261122" });
  });

  it("既定のまま触らなければ、日付が変わると新しい今日へ追従して検索し直す", async () => {
    vi.setSystemTime(new Date(2026, 10, 19, 0, 1));
    await advance(60_000);
    expect(dates()).toEqual(["2026-11-19", "2026-11-19"]);
    expect(lastSearch()).toMatchObject({ studyDateFrom: "20261119", studyDateTo: "20261119" });
  });

  it("負例: 日付を手で変えたあとは、日付が変わっても追従しない", async () => {
    const from = host.querySelectorAll<HTMLInputElement>('input[type="date"]')[0];
    await act(async () => { typeInto(from, "2026-11-01"); });
    await advance(300);
    vi.setSystemTime(new Date(2026, 10, 19, 0, 1));
    await advance(60_000);
    expect(dates()).toEqual(["2026-11-01", "2026-11-18"]);
  });
});
