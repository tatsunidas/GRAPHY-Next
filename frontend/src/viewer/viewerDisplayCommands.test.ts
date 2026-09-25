import { describe, expect, it, vi } from "vitest";
import { registerViewerDisplayCommands, runViewerCommand } from "./viewerCommands";

describe("registerViewerDisplayCommands（動画タイルへ表示の操作を届ける）", () => {
  it("表示の命令は届き、持っていない命令は何もしない", () => {
    const rotate90 = vi.fn();
    const off = registerViewerDisplayCommands("tile-v1", { rotate90 });
    runViewerCommand(["tile-v1"], (c) => c.rotate90());
    runViewerCommand(["tile-v1"], (c) => c.undo()); // 動画は持たない → 落ちない
    runViewerCommand(["tile-v1"], (c) => c.applyLut(null));
    expect(rotate90).toHaveBeenCalledTimes(1);
    off();
    runViewerCommand(["tile-v1"], (c) => c.rotate90());
    expect(rotate90).toHaveBeenCalledTimes(1);
  });

  it("1 タイルに動画が複数あれば全部に届く。外すと、その分だけ届かなくなる", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerViewerDisplayCommands("tile-v2", { setWindowLevel: a });
    const offB = registerViewerDisplayCommands("tile-v2", { setWindowLevel: b });
    runViewerCommand(["tile-v2"], (c) => c.setWindowLevel(128, 64));
    expect(a).toHaveBeenCalledWith(128, 64);
    expect(b).toHaveBeenCalledWith(128, 64);
    offA();
    runViewerCommand(["tile-v2"], (c) => c.setWindowLevel(10, 20));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });
});
