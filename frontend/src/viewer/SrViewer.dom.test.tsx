// @vitest-environment jsdom
/*
 * SrViewer の DOM 検査: 偽の API（fetchSrContent）で SR の木を渡し、見出し・計測の表・折りたたみ・状態が出ること。
 * 🔴 負例: SR の文字列に `<script>`・`<img onerror>` を入れても、要素にならず、**文字としてそのまま**出る（実行されない）。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SrCode, SrDocument, SrNode } from "./srModel";

let result: SrDocument | Error = new Error("unset");
vi.mock("../api", () => ({
  fetchSrContent: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
}));

import { I18nProvider } from "../i18n/i18n";
import { SrViewer } from "./SrViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const code = (value: string, meaning: string | null = null, scheme = "DCM"): SrCode => ({ value, scheme, meaning });
const node = (over: Partial<SrNode>): SrNode => ({
  relationship: "CONTAINS", valueType: null, concept: null, text: null, num: null, code: null, uid: null, date: null, time: null,
  dateTime: null, personName: null, continuity: null, ref: null, graphic: null, temporal: null, children: [], ...over,
});
const doc = (root: SrNode, over: Partial<SrDocument> = {}): SrDocument => ({
  header: { sopClassUid: "1.2.840.10008.5.1.4.1.1.88.33", sopClassName: "Comprehensive SR", studyInstanceUid: "1.1", seriesInstanceUid: "1.2", sopInstanceUid: "1.3",
    completionFlag: "COMPLETE", verificationFlag: "UNVERIFIED", contentDate: "20260802", contentTime: "103000", verifiers: [] },
  root, truncated: false, truncatedReason: null, itemCount: 10, ...over,
});

const cycleSr = doc(node({
  valueType: "CONTAINER", relationship: null, concept: code("X", "Dosimetry cycle 1 (Lu-177, 7400 MBq)"),
  children: [
    node({ valueType: "CONTAINER", concept: code("121070", "Findings"), children: [
      node({ valueType: "TEXT", concept: code("121106", "Comment"), text: "cycle: 1\nactivity-mbq: 7400" }),
    ] }),
    node({ valueType: "CONTAINER", concept: code("126010", "Imaging Measurements"), children: [
      node({ valueType: "CONTAINER", concept: code("125007", "Measurement Group"), children: [
        node({ valueType: "TEXT", concept: code("112039", "Tracking Identifier"), text: "cycle=1;voi=liver" }),
        node({ valueType: "NUM", concept: code("ABSORBED_DOSE", "Absorbed Dose", "99GRAPHY"), num: { value: "1.3215", unit: code("Gy", "Gy", "UCUM"), qualifier: null } }),
        node({ valueType: "NUM", concept: code("T_EFF", "Effective Half-Life", "99GRAPHY"), num: { value: "58.7346", unit: code("h", "h", "UCUM"), qualifier: null } }),
      ] }),
    ] }),
  ],
}));

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function mount() {
  await act(async () => { root.render(createElement(I18nProvider, null, createElement(SrViewer, { studyUid: "1.1", seriesUid: "1.2", sopInstanceUid: "1.3" }))); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

beforeEach(() => {
  localStorage.setItem("graphy.locale", "ja");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("SrViewer", () => {
  it("★ 文書タイトル・状態・日時が先頭に出て、所見は段落（改行を保つ）、計測グループは表になる（書いた値のまま）", async () => {
    result = cycleSr;
    await mount();
    const head = q("sr-header")!.textContent!;
    expect(head).toContain("Dosimetry cycle 1 (Lu-177, 7400 MBq)");
    expect(head).toContain("Comprehensive SR");
    expect(head).toContain("完了");
    expect(head).toContain("未検証");
    expect(head).toContain("2026-08-02 10:30:00");
    const table = q("sr-group-table")!;
    const cells = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
    expect(cells).toEqual([["Absorbed Dose", "1.3215", "Gy"], ["Effective Half-Life", "58.7346", "h"]]);
    // 追跡 ID（表にならない項目）は、グループの中に木として残る
    expect(q("sr-group")!.textContent).toContain("cycle=1;voi=liver");
    // 所見の改行
    const comment = [...host.querySelectorAll<HTMLElement>('[data-testid="sr-item"] span')].find((s) => s.textContent?.includes("activity-mbq"))!;
    expect(comment.textContent).toBe("cycle: 1\nactivity-mbq: 7400");
    expect(comment.style.whiteSpace).toBe("pre-wrap");
  });

  it("節は折りたためる（<details>）。表示直後は開いている", async () => {
    result = cycleSr;
    await mount();
    const details = host.querySelectorAll("details");
    expect(details.length).toBeGreaterThanOrEqual(3);
    expect([...details].every((d) => d.open)).toBe(true);
  });

  it("★ 負例（XSS）: `<script>`・`<img onerror>` を含む値は、要素にならず、文字としてそのまま出る", async () => {
    const evil = `<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">`;
    (window as unknown as { __pwned?: number }).__pwned = 0;
    result = doc(node({
      valueType: "CONTAINER", relationship: null, concept: code("X", evil),
      children: [
        node({ valueType: "TEXT", concept: code("121106", evil), text: evil }),
        node({ valueType: "CONTAINER", concept: code("125007", evil), children: [
          node({ valueType: "NUM", concept: code("Y", evil), num: { value: evil, unit: code("u", evil), qualifier: null } }),
        ] }),
      ],
    }), { header: { ...cycleSr.header, sopClassName: evil, verifiers: [{ organization: evil, dateTime: null, name: evil }] }, truncated: true, truncatedReason: evil });
    await mount();
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBe(0);
    // 文字としては出ている
    expect(host.textContent).toContain("<script>window.__pwned=1</script>");
  });

  it("上限に当たった SR は、黙って切らず、理由を出す", async () => {
    result = doc(cycleSr.root, { truncated: true, truncatedReason: "項目数が上限（20000）を超えました" });
    await mount();
    expect(q("sr-truncated")!.textContent).toContain("項目数が上限");
  });

  it("★ 読めない（SR でない・404）ときは、理由を出す（空の画面にしない）", async () => {
    result = new Error("SR ではありません（SOP クラス: 1.2.840.10008.5.1.4.1.1.2）");
    await mount();
    expect(q("sr-error")!.textContent).toContain("構造化レポートを表示できません");
    expect(q("sr-error")!.textContent).toContain("SR ではありません");
    expect(q("sr-viewer")).toBeNull();
  });

  it("内容が無い SR は「内容がありません」", async () => {
    result = doc(node({ valueType: "CONTAINER", relationship: null, concept: code("X", "Empty"), children: [] }));
    await mount();
    expect(q("sr-viewer")!.textContent).toContain("内容がありません");
  });

  it("［HTML として保存］は、表示と同じ内容の HTML をダウンロードする", async () => {
    result = cycleSr;
    let blob: Blob | null = null;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { blob = b; return "blob:x"; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = () => {};
    await mount();
    await act(async () => { q("sr-save-html")!.click(); });
    expect(blob).not.toBeNull();
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blob!); });
    expect(text.startsWith("<!doctype html>")).toBe(true);
    expect(text).toContain("<td class=\"num\">1.3215</td>");
  });
});
