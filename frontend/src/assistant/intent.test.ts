import { describe, expect, it } from "vitest";
import { pickProfile } from "./intent";
import { buildGuideTools, buildTools } from "./actions/registry";
import { buildSystemPrompt } from "./systemPrompt";

describe("pickProfile", () => {
  it("how-to questions go to the guide", () => {
    for (const q of [
      "今日の花子さんの CT 画像を 2D Viewer で開きたいです。手順を教えてください。",
      "取り込んだ検査が一覧に出ません。どうすればいいですか？",
      "複数の検査をまとめて選択するにはどうしますか？",
      "レポートを PDF にして印刷する手順を教えてください。",
    ]) expect(pickProfile(q)).toBe("guide");
  });
  it("operation requests stay with the operator, in imperative and in want/how-to wording", () => {
    for (const q of [
      "ウィンドウを中心 50、幅 350 にして", "最後のスライスを表示して", "ROI の平均値を教えて", "いまのウィンドウ幅はいくつ？",
      "5 枚先に進みたいです", "画像を 2 倍にしたいです", "もう少し明るくしたいです", "ここを測りたい", "CT の画像を明るくするには、やってください",
      "ウィンドウ幅を変える方法を教えて", "これを消して", "", "   ",
    ]) expect(pickProfile(q)).toBe("full");
  });
  it("a want-form needs an app term; the same form with one goes to the guide", () => {
    expect(pickProfile("画像を拡大したい")).toBe("full");
    expect(pickProfile("検査の一覧をツリー表示に切り替えたいです。")).toBe("guide");
  });
});

describe("guide profile", () => {
  it("offers only propose_steps (the same definition as in the full tool set)", () => {
    const g = buildGuideTools();
    expect(g.map((t) => t.name)).toEqual(["propose_steps"]);
    expect(buildTools().find((t) => t.name === "propose_steps")).toEqual(g[0]);
  });
  it("prompt is short, says it cannot operate, and carries the documents", () => {
    const hit = [{ file: "main-screen.md", heading: "検査を探す", text: "TEXT-BODY", score: 3 }];
    const p = buildSystemPrompt("ja", hit, { guide: true, canOperate: true });
    expect(p).toContain("propose_steps");
    expect(p).toContain("You cannot operate the application");
    expect(p).toContain("--- main-screen.md / 検査を探す\nTEXT-BODY");
    expect(p).not.toContain("getState");
    expect(buildSystemPrompt("ja", hit, { canOperate: true })).toContain("getState");
    expect(buildSystemPrompt("ja", [], { guide: true })).toContain("DOCUMENTS: (no relevant document");
  });
});
