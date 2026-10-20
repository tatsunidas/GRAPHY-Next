/**
 * 提供元フォームの「下書き ⇄ 保存する形」の変換。設計: `fw/ai-routing-design.md` §14
 *
 * ⚠ **このリポジトリには UI コンポーネントのテスト環境が無い**（vitest は node 環境で、
 * jsdom も testing-library も入っていない）。だから**押す操作は実機でしか守れない**
 * （CLAUDE.md ルール 9）。
 *
 * 🔑 そのぶん、間違えると実害が出る変換だけを**純関数に切り出して**ここで固定する:
 *   - 空欄を「未指定」として**項目ごと落とす**こと（残すと「既定」が上書きされる）
 *   - 検査コードを人の言葉に写すこと（訳が無いものは生のまま出す）
 */
import { describe, expect, it } from "vitest";
import { emptyDraft, fromDraft, toDraft, describeProblem, presetDraft, modelCandidates } from "./AiProviderForm";
import { ja } from "../i18n/ja";

const CAPS = ["image-to-image", "image-to-text"];

/** i18n の実物を使う（キーが無ければキー名がそのまま返る）。 */
const t = (k: string, v?: Record<string, string | number>) => {
  const raw = (ja as Record<string, string>)[k];
  if (raw === undefined) return k;
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(v?.[name] ?? ""));
};

describe("下書き → 保存する形", () => {
  it("🔴 空欄の用途は models に入れない（＝その用途は使えない）", () => {
    const d = { ...emptyDraft(CAPS), id: "grok", endpoint: "https://api.x.ai" };
    d.models["image-to-text"] = "grok-4";
    const e = fromDraft(d);
    expect(e.models).toEqual({ "image-to-text": "grok-4" });
  });

  it("🔴 詳細設定が空なら項目ごと落とす（未指定＝アダプタの既定を使う）", () => {
    const e = fromDraft({ ...emptyDraft(CAPS), id: "x", endpoint: "https://a.test", models: { "image-to-text": "m" } });
    expect("auth" in e).toBe(false);
    expect("pathStyle" in e).toBe(false);
    expect("apiVersion" in e).toBe(false);
    expect("paths" in e).toBe(false);
  });

  it("前後の空白を落とし、表示名が空なら id を使う", () => {
    const e = fromDraft({
      ...emptyDraft(CAPS), id: "  grok  ", label: "   ", endpoint: " https://api.x.ai ",
      models: { "image-to-text": " grok-4 " },
    });
    expect(e.id).toBe("grok");
    expect(e.label).toBe("grok");
    expect(e.endpoint).toBe("https://api.x.ai");
    expect(e.models["image-to-text"]).toBe("grok-4");
  });

  it("🔑 接頭辞だけを空文字にする指定は残す（「接頭辞なし」は未指定ではない）", () => {
    const e = fromDraft({ ...emptyDraft(CAPS), id: "x", endpoint: "https://a.test",
                          authHeader: "x-api-key", authPrefix: "", models: { "image-to-text": "m" } });
    expect(e.auth).toEqual({ header: "x-api-key", prefix: "" });
  });

  it("パスは書いた用途だけ持つ", () => {
    const d = { ...emptyDraft(CAPS), id: "x", endpoint: "https://a.test", models: { "image-to-text": "m" } };
    d.paths["image-to-text"] = "/api/v1/chat/completions";
    expect(fromDraft(d).paths).toEqual({ "image-to-text": "/api/v1/chat/completions" });
  });
});

describe("保存されている形 → 下書き", () => {
  it("往復して同じものになる", () => {
    const entry = {
      id: "az", label: "院内 Azure", kind: "azure-openai", endpoint: "https://hosp.openai.azure.test",
      apiVersion: "2025-01-01", pathStyle: "azure-deployment",
      auth: { header: "api-key", prefix: "" },
      paths: { "image-to-text": "/openai/deployments/dep/chat/completions" },
      models: { "image-to-text": "dep" },
    };
    expect(fromDraft(toDraft(entry, CAPS))).toEqual(entry);
  });

  it("旧い形（文字列の auth）は下書きでは既定扱いになる", () => {
    const entry = { id: "g", label: "G", kind: "gemini", endpoint: "https://g.test",
                    auth: "api-key", models: { "image-to-text": "m" } };
    const back = fromDraft(toDraft(entry, CAPS));
    // 文字列 auth は「既定に任せる」と同じ意味なので、往復で落ちてよい。
    expect("auth" in back).toBe(false);
    expect(back.endpoint).toBe("https://g.test");
  });
});

describe("検査コードを人の言葉にする", () => {
  it("提供元ごとの接頭辞を外して訳す", () => {
    expect(describeProblem("provider:grok:endpoint-has-path", t))
      .toBe(ja["settings.ai.problem.endpoint-has-path"]);
  });

  it("引数つきのコードを埋める", () => {
    expect(describeProblem("provider:grok:header-not-allowed:host", t)).toContain("host");
  });

  it("config: の接頭辞も外す", () => {
    expect(describeProblem("config:parse-error:Unexpected token", t))
      .toBe(ja["settings.ai.problem.parse-error"]);
  });

  it("🔑 訳が無いコードは生のまま出す（何も出ないより手がかりが残る）", () => {
    expect(describeProblem("provider:x:brand-new-rule", t)).toBe("provider:x:brand-new-rule");
  });
});

describe("提供元のプリセット", () => {
  it("OpenAI は id・種別・接続先が入り、モデル名は空（仮の値を置かない）", () => {
    const d = presetDraft("openai", [], CAPS);
    expect([d.id, d.kind, d.endpoint]).toEqual(["openai", "openai", "https://api.openai.com"]);
    expect(Object.values(d.models).every((m) => m === "")).toBe(true);
    expect(fromDraft(d).models).toEqual({});
  });
  it("Gemini は gemini の系統と公式の接続先", () => {
    const d = presetDraft("gemini", [], CAPS);
    expect([d.kind, d.endpoint]).toEqual(["gemini", "https://generativelanguage.googleapis.com"]);
  });
  it("Azure は接続先が利用者ごとなので空のまま", () => {
    const d = presetDraft("azure", [], CAPS);
    expect([d.kind, d.endpoint]).toEqual(["azure-openai", ""]);
  });
  it("🔑 id が既存と重なれば -2, -3 を付ける（既存の鍵を上書きしない）", () => {
    expect(presetDraft("openai", ["openai"], CAPS).id).toBe("openai-2");
    expect(presetDraft("openai", ["openai", "openai-2"], CAPS).id).toBe("openai-3");
  });
  it("その他は白紙（id も接続先も自分で書く）", () => {
    const d = presetDraft("other", ["openai"], CAPS);
    expect([d.id, d.label, d.endpoint]).toEqual(["", "", ""]);
  });
});

describe("用途ごとのモデル候補", () => {
  // 実際の OpenAI の一覧（ユーザーの鍵で取得。80 件ほどの後半を転記し、設定にあった gpt-4・gpt-4.1-mini を足した）
  const REAL = [
    "gpt-4", "gpt-4.1-mini", "gpt-5.2", "gpt-5.4-mini", "gpt-5.5", "gpt-audio", "gpt-audio-mini", "gpt-image-1", "gpt-image-1-mini",
    "gpt-image-1.5", "gpt-image-2", "gpt-image-2-2026-04-21", "gpt-live-1", "gpt-realtime", "gpt-realtime-mini", "gpt-transcribe",
    "o1", "o3", "o3-mini", "o4-mini", "omni-moderation-latest", "sora-2", "text-embedding-3-small", "tts-1", "tts-1-hd", "whisper-1",
  ];
  const img = modelCandidates(REAL, "image-to-image");
  const txt = modelCandidates(REAL, "image-to-text");

  it("画像→画像: 画像用だけが入り、チャット用・音声・埋め込みは入らない（取り違えの再発防止）", () => {
    expect(img).toEqual(["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2-2026-04-21"]);
    for (const bad of ["gpt-4", "gpt-4.1-mini", "o3", "tts-1", "text-embedding-3-small", "whisper-1"]) expect(img).not.toContain(bad);
  });
  it("画像→文章: チャット用が入り、画像用・音声・埋め込み・動画は入らない", () => {
    for (const ok of ["gpt-4", "gpt-4.1-mini", "gpt-5.4-mini", "o3", "o4-mini"]) expect(txt).toContain(ok);
    for (const bad of ["gpt-image-1", "gpt-audio", "gpt-realtime", "whisper-1", "tts-1", "text-embedding-3-small", "sora-2", "omni-moderation-latest", "gpt-live-1", "gpt-transcribe"]) expect(txt).not.toContain(bad);
  });
  it("🔑 絞って空になるときは全件に戻す（候補が消えて手入力しかできない、を作らない）", () => {
    expect(modelCandidates(["gemini-2.5-flash", "gemini-2.5-pro"], "image-to-image")).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(modelCandidates(["gpt-image-1"], "image-to-text")).toEqual(["gpt-image-1"]);
  });
  it("Gemini の画像モデルは画像用に入る", () => {
    expect(modelCandidates(["gemini-2.5-flash", "gemini-3.1-flash-image"], "image-to-image")).toEqual(["gemini-3.1-flash-image"]);
  });
  it("知らない用途は全件", () => {
    expect(modelCandidates(REAL, "other")).toEqual(REAL);
  });
});
