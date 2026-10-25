/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグインの画像を外部 AI へ送る前の関門（graphy:ai-generate）。`electron` は import しない
// （`node --test` が npm install なしで走るため）。
//
// 🔴 プラグインは renderer に import() されるので、renderer 側の同意・監査は素通りできる。同意と監査はここ（main）に置く。
// 🔴 main は呼び出し元のプラグインを区別できない。`claimedPluginId` は**自己申告**で、権限の証明ではない
//    （インストール済みで ai-egress を宣言しているプラグインの id に限り受理するだけ）。ダイアログにも自己申告と出す。
const { oneLine } = require("./assistantPluginTools");
const MAX_PROMPT_PREVIEW = 1000;

/**
 * @param {object} deps
 * @param {(id: string) => Promise<{id: string, name?: string, permissions?: string[]} | null>} deps.lookupPlugin  main が backend から引く
 * @param {(capability: string) => object} deps.resolve  aiGateway.resolveCapability
 * @param {(info: object) => Promise<{ok: boolean, remember?: boolean}>} deps.confirm  ネイティブ確認
 * @param {(line: string) => void} deps.audit
 */
function createGate({ lookupPlugin, resolve, confirm, audit }) {
  /** 「このスコープでは再確認しない」。セッション内のみ・永続化しない。 */
  const remembered = new Set();

  /**
   * @returns {Promise<{ok: true, req: object} | {ok: false, error: string}>} ok のとき req は aiGateway.generate に渡してよい形
   *   （自己申告フィールドは除去済み）。
   */
  async function check(req) {
    if (!req || typeof req !== "object") return { ok: false, error: "empty-request" };
    const claimed = typeof req.claimedPluginId === "string" ? req.claimedPluginId : "";
    const scopeKey = typeof req.scopeKey === "string" ? req.scopeKey.slice(0, 200) : "";
    const { claimedPluginId: _c, scopeKey: _s, ...forward } = req;

    let plugin = null;
    try {
      plugin = claimed ? await lookupPlugin(claimed) : null;
    } catch {
      plugin = null;
    }
    if (!plugin || !Array.isArray(plugin.permissions) || !plugin.permissions.includes("ai-egress")) {
      return { ok: false, error: "unknown-caller" };
    }

    const capability = typeof req.capability === "string" && req.capability ? req.capability : "image-to-image";
    const plan = resolve(capability);
    if (!plan || !plan.ok) return { ok: false, error: (plan && plan.error) || "no-provider" };

    // 鍵が無いまま確認だけ取らせない（取ってから失敗する形にしない）。
    if (plan.hasApiKey === false) return { ok: false, error: "no-api-key" };

    // 確認が要るのはローカルと判定できない宛先だけ（ループバックは端末の外へ出ない）。
    if (plan.local !== true) {
      const scope = `${plugin.id}::${plan.providerId}::${scopeKey}`;
      if (!(scopeKey && remembered.has(scope))) {
        let answer;
        try {
          answer = await confirm({
            pluginId: plugin.id,
            pluginName: oneLine(plugin.name || plugin.id, 60),
            host: plan.endpointHost,
            label: plan.label,
            // aiGateway.generate と同じ規則: 用途が来ていれば解決したモデル、旧来の呼び出し(用途なし)だけ呼び出し側の指定。
            model: !req.capability && typeof req.model === "string" && req.model ? req.model : plan.model,
            plaintext: plan.plaintext === true,
            prompt: oneLine(req.prompt, MAX_PROMPT_PREVIEW),
            imageBase64: typeof req.imageBase64 === "string" ? req.imageBase64 : "",
            canRemember: !!scopeKey,
          });
        } catch {
          return { ok: false, error: "canceled" };
        }
        if (!answer || answer.ok !== true) return { ok: false, error: "canceled" };
        if (answer.remember === true && scopeKey) remembered.add(scope);
      }
    }

    // 画像・プロンプトの本文は残さない。いつ・どのプラグイン(自己申告)が・どこへ・どれだけ。
    audit(
      `[ai] egress plugin=${plugin.id}(claimed) provider=${plan.providerId} host=${plan.endpointHost} local=${plan.local === true} ` +
        `capability=${capability} bytes=${typeof req.imageBase64 === "string" ? req.imageBase64.length : 0} ` +
        `promptChars=${typeof req.prompt === "string" ? req.prompt.length : 0}`,
    );
    return { ok: true, req: forward };
  }

  return { check, forget: () => remembered.clear() };
}

module.exports = { createGate, MAX_PROMPT_PREVIEW };
