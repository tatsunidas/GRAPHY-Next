import { afterEach, describe, expect, it, vi } from "vitest";
import { registerToolRequestHandler, requestTool } from "./viewerCommands";

describe("タイルから画面へのツール切替の依頼", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("画面が登録していれば、依頼が届いて true（画面のツールバーと同じ setTool へ通る）", () => {
    const handler = vi.fn();
    cleanups.push(registerToolRequestHandler(handler));
    expect(requestTool("Pan")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("Pan");
  });

  it("画面が無い（登録なし）ときは false。呼び出し側がタイル単独で切り替える", () => {
    expect(requestTool("Pan")).toBe(false);
  });

  it("解除すると false に戻る", () => {
    const handler = vi.fn();
    const off = registerToolRequestHandler(handler);
    off();
    expect(requestTool("Pan")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("古い登録の解除は、後から登録した画面を消さない（再マウントの順序に強い）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerToolRequestHandler(first);
    cleanups.push(registerToolRequestHandler(second));
    offFirst();
    expect(requestTool("WindowLevel")).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("WindowLevel");
    expect(first).not.toHaveBeenCalled();
  });
});
