// 軽量ロガー。debug は dev または localStorage("graphy.debug")="true" のときのみ出力。
// 過剰ログを避けつつ、リスク箇所・未検証箇所のトラブル追跡用に debug を残せる。

function debugEnabled(): boolean {
  try {
    if (localStorage.getItem("graphy.debug") === "true") return true;
  } catch {
    // ignore
  }
  return Boolean(import.meta.env?.DEV);
}

const PREFIX = "[graphy]";

export const log = {
  debug: (...args: unknown[]) => {
    if (debugEnabled()) console.debug(PREFIX, ...args);
  },
  info: (...args: unknown[]) => console.info(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
};
