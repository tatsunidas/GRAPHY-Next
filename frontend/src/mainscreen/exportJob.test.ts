import { describe, expect, it } from "vitest";
import type { ExportJobStatus } from "../api";
import { exportPercent, isExportFinished, runExportJob } from "./exportJob";

const st = (over: Partial<ExportJobStatus>): ExportJobStatus => ({
  jobId: "j1",
  state: "RUNNING",
  total: 10,
  processed: 0,
  outputPath: null,
  error: null,
  ...over,
});

describe("exportPercent", () => {
  it("総数が分かるまでは不定", () => {
    expect(exportPercent(st({ state: "QUEUED" }))).toBeNull();
    expect(exportPercent(st({ total: -1 }))).toBeNull();
  });
  it("割合を丸めて上限 100", () => {
    expect(exportPercent(st({ processed: 3 }))).toBe(30);
    expect(exportPercent(st({ processed: 12 }))).toBe(100);
  });
});

describe("runExportJob", () => {
  const noSleep = () => Promise.resolve();

  it("終わるまで問い合わせ、最後の状態を返す", async () => {
    const seq = [st({ processed: 4 }), st({ processed: 10, state: "DONE", outputPath: "D:/x" })];
    let i = 0;
    const seen: number[] = [];
    const r = await runExportJob(
      { submit: async () => st({ state: "QUEUED" }), get: async () => seq[i++], cancel: async () => ({}) },
      (s) => seen.push(s.processed),
      () => false,
      0,
      noSleep,
    );
    expect(r.state).toBe("DONE");
    expect(isExportFinished(r)).toBe(true);
    expect(seen).toEqual([0, 4, 10]);
  });

  it("中止は 1 回だけ送り、止まるまで問い合わせを続ける", async () => {
    let cancels = 0;
    let polls = 0;
    const r = await runExportJob(
      {
        submit: async () => st({}),
        get: async () => (++polls < 3 ? st({ processed: polls }) : st({ state: "CANCELLED" })),
        cancel: async () => {
          cancels++;
        },
      },
      () => undefined,
      () => true,
      0,
      noSleep,
    );
    expect(cancels).toBe(1);
    expect(r.state).toBe("CANCELLED");
  });

  it("負例: 中止を求めなければ cancel は呼ばれない", async () => {
    let cancels = 0;
    await runExportJob(
      { submit: async () => st({}), get: async () => st({ state: "DONE" }), cancel: async () => void cancels++ },
      () => undefined,
      () => false,
      0,
      noSleep,
    );
    expect(cancels).toBe(0);
  });
});
