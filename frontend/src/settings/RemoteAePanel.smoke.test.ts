// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 通信先パネルの DOM の煙テスト: 実際に描画し、［通信テスト］を押して 1 段ずつ進む表示を確かめ、
// 通った探し方を［採用］→［保存］で通信先に書くところまで通す。本体の API は fetch の偽物（fakeHost）で渡す。
// 偽の相手は 切断型（標準の探し方は切断され、最小の項目なら通る）と、何も変えずに通る相手の 2 通り。
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { RemoteAePanel } from "./RemoteAePanel";

// 同じ画面に載る別機能のパネル（TLS・受信時の匿名化）は、このテストの対象外。
vi.mock("./DicomTlsSection", () => ({ DicomTlsSection: () => null }));
vi.mock("./ReceiveAnonymizePanel", () => ({ ReceiveAnonymizePanel: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { method: string; path: string; body: string | null }

let calls: Call[];
let settings: Record<string, string>;
let scenario: "psp" | "plain" | "unreachable";
let host: HTMLElement;
let root: Root;

const json = (body: unknown, statusCode = 200) =>
  new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });

function result(id: string, stage: string, verdict: string, extra: Record<string, unknown> = {}) {
  return {
    id, stage, label: `label-${id}`, verdict, kind: verdict === "ok" ? "OK" : null, status: null, errorComment: null,
    reason: null, count: verdict === "ok" ? 1 : null, returnedKeys: [], millis: 3, command: `findscu ${id}`,
    evidence: null, sampleStudyUid: null, adopt: null, ...extra,
  };
}

const PLAN = [
  { id: "echo", stage: "echo", label: "e" },
  { id: "find-minimal", stage: "find", label: "m" },
  { id: "find-standard", stage: "find", label: "s" },
  { id: "get", stage: "get", label: "g" },
  { id: "move", stage: "move", label: "mv" },
];

function runStep(stepId: string) {
  if (scenario === "unreachable") {
    return stepId === "echo" ? result("echo", "echo", "ng", { kind: "UNREACHABLE" }) : result(stepId, "x", "skipped");
  }
  switch (stepId) {
    case "echo": return result("echo", "echo", "ok");
    case "find-minimal":
      return result("find-minimal", "find", "ok", {
        label: "最小の項目だけで検索", returnedKeys: ["StudyInstanceUID"], sampleStudyUid: "1.2.3",
        adopt: { studyKeys: ["StudyInstanceUID"] },
      });
    case "find-standard":
      return scenario === "psp"
        ? result("find-standard", "find", "ng", { kind: "DROPPED", label: "標準" })
        : result("find-standard", "find", "ok", { label: "標準", adopt: {} });
    case "get": return result("get", "get", "ng", { kind: "SERVICE_REFUSED" });
    default: return result("move", "move", "ok");
  }
}

function fakeHost(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, path, body: typeof init?.body === "string" ? init.body : null });
  if (path === "/api/settings" && method === "GET") return Promise.resolve(json(settings));
  if (path === "/api/settings" && method === "PUT") {
    settings = { ...settings, ...JSON.parse(String(init?.body)) };
    return Promise.resolve(json(settings));
  }
  if (path === "/api/dicom/remote-aes") return Promise.resolve(json([]));
  if (path === "/api/dicom/tls-config") {
    return Promise.resolve(json({
      enabled: false, port: 2762, keyStore: "", keyStorePassword: null, keyStoreType: "PKCS12", trustStore: "",
      trustStorePassword: null, trustStoreType: "PKCS12", protocols: [], cipherSuites: [], needClientAuth: false,
      usable: false, keyStorePasswordSet: false, trustStorePasswordSet: false,
    }));
  }
  if (path === "/api/dicom/qr/probe/plan") return Promise.resolve(json(PLAN));
  if (path === "/api/dicom/qr/probe/run") {
    return Promise.resolve(json(runStep(JSON.parse(String(init?.body)).stepId)));
  }
  return Promise.resolve(json({}));
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(id: string) {
  await act(async () => { q(id)!.click(); });
  await flush();
  await flush();
}
async function until(cond: () => boolean) {
  for (let i = 0; i < 40 && !cond(); i++) await flush();
}

beforeEach(async () => {
  calls = [];
  scenario = "psp";
  settings = { "dicom.remoteAes": JSON.stringify([{ aeTitle: "RELAY", host: "10.0.0.5", port: 4000, tls: false }]) };
  vi.stubGlobal("fetch", vi.fn(fakeHost));
  localStorage.setItem("graphy.locale", "ja"); // 文言は日本語で確かめる
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(I18nProvider, null, createElement(RemoteAePanel))); });
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const tone = (id: string) => q(`probe-row-${id}`)?.getAttribute("data-tone");

describe("RemoteAePanel の通信テスト（実際に描画して操作する）", () => {
  it("切断型: 標準は切断・最小なら通る → 採用 → 保存で、通信先の find に書かれる", async () => {
    await click("probe-open-0");
    expect(q("probe-panel")).not.toBeNull();
    await click("probe-start");
    await until(() => q("probe-summary") !== null);

    expect(tone("echo")).toBe("ok");
    expect(tone("find")).toBe("ok");
    expect(tone("get")).toBe("ng");
    expect(tone("move")).toBe("ok");
    expect(q("probe-row-find")!.textContent).toContain("標準の探し方では通らず");
    expect(q("probe-row-get")!.textContent).toContain("→ MOVE が通るなら MOVE で取得できます"); // ✕ の行に次にすること
    expect(q("probe-pattern-find-standard")).not.toBeNull();
    // 患者の値は、報告にも画面にも出ない（偽の結果には入れていない）が、コマンド行は出る
    expect(q("probe-report")!.textContent).toContain("RELAY@10.0.0.5:4000");

    // 保存するまで、保存しない
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    await click("probe-adopt");
    expect(q("probe-adopted")).not.toBeNull();
    expect(host.textContent).toContain("標準と異なる");

    const saveBtn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "保存")!;
    await act(async () => { saveBtn.click(); });
    await flush();
    const put = calls.filter((c) => c.method === "PUT").pop()!;
    const saved = JSON.parse(JSON.parse(put.body!)["dicom.remoteAes"]);
    expect(saved).toEqual([{ aeTitle: "RELAY", host: "10.0.0.5", port: 4000, tls: false, find: { studyKeys: ["StudyInstanceUID"] } }]);
  });

  it("既定のまま通る相手: 採用ボタンは出ない（設定は変わらず、保存しても find は付かない）", async () => {
    scenario = "plain";
    await click("probe-open-0");
    await click("probe-start");
    await until(() => q("probe-summary") !== null);
    expect(q("probe-row-find")!.textContent).toContain("標準の探し方のままで使えます");
    expect(q("probe-adopt")).toBeNull();
    expect(host.textContent).not.toContain("標準と異なる");
  });

  it("つながらない相手: ✕ と次にすること。以降の段は呼ばない", async () => {
    scenario = "unreachable";
    await click("probe-open-0");
    await click("probe-start");
    await until(() => q("probe-summary") !== null);
    expect(tone("echo")).toBe("ng");
    expect(q("probe-row-echo")!.textContent).toContain("→");
    expect(tone("find")).toBe("muted");
    const runs = calls.filter((c) => c.path === "/api/dicom/qr/probe/run").map((c) => JSON.parse(c.body!).stepId);
    expect(runs).toEqual(["echo"]);
  });

  it("検索の詳細: 変更すると『標準と異なる』が出て、保存した JSON に入る。標準に戻すと消える", async () => {
    await click("find-open-0");
    const sel = q("fp-model") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "PatientRoot");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("標準と異なる");
    const saveBtn = () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "保存")!;
    await act(async () => { saveBtn().click(); });
    await flush();
    let put = calls.filter((c) => c.method === "PUT").pop()!;
    expect(JSON.parse(JSON.parse(put.body!)["dicom.remoteAes"])[0].find).toEqual({ model: "PatientRoot" });

    await click("fp-reset");
    expect(host.textContent).not.toContain("標準と異なる");
    await act(async () => { saveBtn().click(); });
    await flush();
    put = calls.filter((c) => c.method === "PUT").pop()!;
    expect(JSON.parse(JSON.parse(put.body!)["dicom.remoteAes"])[0]).not.toHaveProperty("find");
  });
});
