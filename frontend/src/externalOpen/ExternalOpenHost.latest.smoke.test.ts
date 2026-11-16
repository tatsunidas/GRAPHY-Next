// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 電子カルテの患者の直近の検査を開く流れの DOM の煙テスト: 本体の API は fetch の偽物、デスクトップの橋は偽物で渡す。
// 見るもの: 開いた検査の UID（PACS の直近）、患者が切り替わったとき前の患者を開かないこと、理由の出し方。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { EMR_OPEN_EVENT, ExternalOpenHost } from "./ExternalOpenHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fetch = { state: string; patientId: string | null; found: number; retrieved: number; latestStudyUid: string | null; latestReady: boolean; error: string | null };

let fetchState: Fetch;
let local: Array<Record<string, unknown>>;
let opened: string[];
let externalCb: ((raw: unknown) => void) | null;
let host: HTMLElement;
let root: Root;

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const idle = (): Fetch => ({ state: "idle", patientId: null, found: 0, retrieved: 0, latestStudyUid: null, latestReady: false, error: null });
const study = (uid: string, pid: string, date: string) => ({
  studyInstanceUid: uid, patientId: pid, patientName: "N", studyDate: date, studyDescription: null, modality: "CT", numberOfInstances: 1,
});

function fakeHost(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), "http://x");
  if (url.pathname === "/api/emr/status") return Promise.resolve(json({ enabled: true, valid: true, errors: [], autoOpen: true, file: { state: "ok", error: null, lastReadAt: 1 }, patient: null, fetch: fetchState }));
  if (url.pathname === "/api/studies") {
    const uid = url.searchParams.get("studyInstanceUid");
    const pid = url.searchParams.get("patientId");
    return Promise.resolve(json(local.filter((s) => (uid ? s.studyInstanceUid === uid : pid ? String(s.patientId).includes(pid) : true))));
  }
  const m = /^\/api\/studies\/([^/]+)\/series$/.exec(url.pathname);
  if (m) return Promise.resolve(json([{ seriesInstanceUid: m[1] + ".s1", modality: "CT", seriesNumber: 1, seriesDescription: "x", numberOfInstances: 1 }]));
  if (url.pathname === "/api/settings") return Promise.resolve(json({}));
  return Promise.resolve(json({ message: "unexpected " + url.pathname }, 404));
}

const dialog = () => host.querySelector<HTMLElement>('[data-testid="external-open-dialog"]');
const ctx = () => JSON.parse(localStorage.getItem("graphy-viewer-ctx") ?? "null") as { study: { studyInstanceUid: string }; series?: { seriesInstanceUid: string } } | null;
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const requestOpen = (patientId: string) => act(async () => { window.dispatchEvent(new CustomEvent(EMR_OPEN_EVENT, { detail: { patientId } })); });
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(50);
}

beforeEach(async () => {
  fetchState = idle();
  local = [];
  opened = [];
  externalCb = null;
  localStorage.clear();
  localStorage.setItem("graphy.locale", "ja");
  vi.stubGlobal("fetch", vi.fn(fakeHost));
  (window as unknown as { graphyDesktop: unknown }).graphyDesktop = {
    onExternalOpen: (cb: (raw: unknown) => void) => { externalCb = cb; return () => undefined; },
    externalOpenReady: () => undefined,
    openViewer: (k: string) => { opened.push(k + ":" + (ctx()?.study.studyInstanceUid ?? "")); return Promise.resolve(); },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(I18nProvider, null, createElement(ExternalOpenHost))); });
  await sleep(0);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (window as unknown as { graphyDesktop?: unknown }).graphyDesktop;
});

describe("電子カルテの患者の直近の検査を開く", () => {
  it("取り込みが終わったら、PACS の直近の検査を、先頭のシリーズで開く（手元にもっと古い検査があっても、そちらではない）", async () => {
    local = [study("1.old", "P1", "20240101"), study("1.new", "P1", "20260101")];
    fetchState = { ...idle(), state: "retrieving", patientId: "P1", found: 2, retrieved: 1, latestStudyUid: "1.new", latestReady: true };
    await requestOpen("P1");
    await until(() => opened.length > 0);
    expect(opened).toEqual(["2dviewer:1.new"]);
    expect(ctx()!.series!.seriesInstanceUid).toBe("1.new.s1");
    expect(dialog()).toBeNull();
  });

  it("まだ取れていない間は開かず、取れた時点で開く", async () => {
    local = [study("1.new", "P1", "20260101")];
    fetchState = { ...idle(), state: "retrieving", patientId: "P1", found: 3, retrieved: 0, latestStudyUid: "1.new", latestReady: false };
    await requestOpen("P1");
    await sleep(700);
    expect(opened).toEqual([]); // 待っている
    fetchState = { ...fetchState, retrieved: 1, latestReady: true };
    await until(() => opened.length > 0);
    expect(opened).toEqual(["2dviewer:1.new"]);
  });

  it("🔴 患者が切り替わったら、前の患者の待ちを捨てる（前の患者が、あとから開かない）", async () => {
    local = [study("1.p1", "P1", "20260101"), study("1.p2", "P2", "20260102")];
    fetchState = { ...idle(), state: "retrieving", patientId: "P1", found: 1, latestStudyUid: "1.p1", latestReady: false };
    await requestOpen("P1");
    await sleep(600);
    await requestOpen("P2"); // 電子カルテが、次の患者に切り替わった
    // P1 の取り込みが、あとから終わっても
    fetchState = { ...fetchState, latestReady: true };
    await sleep(900);
    expect(opened).toEqual([]); // 状態は P1 のもので、P2 の待ちには効かない。P1 の待ちは捨てられている
    fetchState = { ...idle(), state: "retrieving", patientId: "P2", found: 1, latestStudyUid: "1.p2", latestReady: true };
    await until(() => opened.length > 0);
    await sleep(900); // 古い待ちが、遅れて開かないことを見届ける
    expect(opened).toEqual(["2dviewer:1.p2"]);
  });

  it("PACS に無いとき: 手元にその患者の検査があれば最新を開く／無ければ理由を出して何も開かない", async () => {
    local = [study("1.a", "P1", "20250101"), study("1.b", "P1", "20250601"), study("1.x", "P10", "20270101")];
    fetchState = { ...idle(), state: "not-found", patientId: "P1" };
    await requestOpen("P1");
    await until(() => opened.length > 0);
    expect(opened).toEqual(["2dviewer:1.b"]); // 部分一致の P10 は選ばない
    opened = [];
    fetchState = { ...idle(), state: "not-found", patientId: "P9" };
    await requestOpen("P9");
    await until(() => dialog() !== null);
    expect(dialog()!.textContent).toContain("PACS にも手元にもありません");
    expect(opened).toEqual([]);
  });

  it("取り込みに失敗しても、手元に検査があればそれを開く。無ければ、開かずに理由を出す", async () => {
    local = [study("1.a", "P1", "20250101")];
    fetchState = { ...idle(), state: "error", patientId: "P1", error: "find-failed:DROPPED" };
    await requestOpen("P1");
    await until(() => opened.length > 0);
    expect(opened).toEqual(["2dviewer:1.a"]);
    opened = [];
    local = [];
    await requestOpen("P1");
    await until(() => dialog() !== null);
    expect(dialog()!.textContent).toContain("開けませんでした");
    expect(opened).toEqual([]);
  });

  it("患者の ID が読めていないとき（ID なし）は、その旨を出す。不正な latest の要求は開かない", async () => {
    await requestOpen("");
    await until(() => dialog() !== null);
    expect(dialog()!.textContent).toContain("まだ読めていません");
    expect(opened).toEqual([]);
    // main から届く要求も検証される（latest に検査日が付いていると、開かない）
    await act(async () => { externalCb!({ ok: true, req: { patientId: "P1", latest: true, studyDate: "20260101" } }); });
    await sleep(200);
    expect(opened).toEqual([]);
  });

  it("main から届く latest の要求でも、同じ流れで開く", async () => {
    local = [study("1.m", "P7", "20260301")];
    fetchState = { ...idle(), state: "done", patientId: "P7", found: 1, retrieved: 1, latestStudyUid: "1.m", latestReady: true };
    await act(async () => { externalCb!({ ok: true, req: { patientId: "P7", latest: true } }); });
    await until(() => opened.length > 0);
    expect(opened).toEqual(["2dviewer:1.m"]);
  });
});
