// 会話の口（`graphy:ai-chat*`）を呼んでよい窓の判定。設計: fw/ai-routing-design.md §15
//
// 🔴 **なぜ要るのか。** プラグインは viewer / main 窓のレンダラで動き、`window.graphyDesktop` の口が
//    全部見える（§14.2）。会話の口は画像も文章も任意に外部へ送れるので、プラグインから呼べると
//    同意も監査も通らない送信経路になる。アシスタント専用の窓（`#assistant`）だけを通す。
//    その窓にはプラグインを読み込まない。
//
// 🔴 `electron` を import しない（`node --test` が npm install 無しで走る）。

/** 窓の URL がアシスタント窓か。ハッシュが `#assistant`（後ろに `?…` や `/…` が続いてもよい）。 */
function isAssistantUrl(url) {
  let hash;
  try {
    hash = new URL(String(url)).hash;
  } catch {
    return false;
  }
  return /^#assistant(?:[/?]|$)/.test(hash);
}

/**
 * IPC イベントの送信元がアシスタント窓の**メインフレーム**か。
 * iframe からの呼び出しは通さない（親が `#assistant` でも、中身は別のオリジンかもしれない）。
 */
function isAssistantSender(event) {
  const frame = event && event.senderFrame;
  const sender = event && event.sender;
  if (!frame || !sender || frame !== sender.mainFrame) return false;
  return isAssistantUrl(frame.url);
}

module.exports = { isAssistantUrl, isAssistantSender };
