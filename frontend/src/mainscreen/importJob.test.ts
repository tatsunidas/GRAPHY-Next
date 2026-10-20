import { describe, expect, it } from "vitest";
import type { ImportJobStatus } from "../api";
import { isFinished, progressPercent, runImportJob } from "./importJob";

const st = (o: Partial<ImportJobStatus>): ImportJobStatus => ({
  jobId: "j", state: "IMPORTING", total: 10, processed: 0, imported: 0, skipped: 0, failed: 0, result: null, error: null, ...o,
});

describe("progressPercent", () => {
  it("総数が分からない間は不定（null）", () => {
    expect(progressPercent(st({ state: "SCANNING", total: -1 }))).toBeNull();
    expect(progressPercent(st({ total: -1 }))).toBeNull();
    expect(progressPercent(st({ total: 0 }))).toBeNull();
  });
  it("割合を返し、総数を超えても 100 で止める", () => {
    expect(progressPercent(st({ processed: 5 }))).toBe(50);
    expect(progressPercent(st({ processed: 12 }))).toBe(100);
  });
});

describe("runImportJob", () => {
  const noSleep = () => Promise.resolve();

  it("終わるまで問い合わせ、進捗を順に渡す", async () => {
    const seq = [st({ processed: 3 }), st({ processed: 7 }), st({ state: "DONE", processed: 10 })];
    const seen: number[] = [];
    const api = {
      submit: async () => st({ state: "QUEUED", total: -1 }),
      get: async () => seq.shift()!,
      cancel: async () => undefined,
    };
    const r = await runImportJob(api, ["/a"], (s) => seen.push(s.processed), () => false, 1, noSleep);
    expect(r.state).toBe("DONE");
    expect(seen).toEqual([0, 3, 7, 10]);
  });

  it("中止は 1 回だけ送り、止まった結果を受け取るまで続ける", async () => {
    let cancels = 0;
    let polls = 0;
    const api = {
      submit: async () => st({ state: "QUEUED" }),
      get: async () => {
        polls += 1;
        return cancels > 0 && polls >= 3 ? st({ state: "CANCELLED", imported: 4, processed: 4 }) : st({ processed: polls });
      },
      cancel: async () => {
        cancels += 1;
      },
    };
    let want = false;
    const r = await runImportJob(api, ["/a"], (s) => { if (s.processed >= 1) want = true; }, () => want, 1, noSleep);
    expect(cancels).toBe(1);
    expect(r.state).toBe("CANCELLED");
    expect(r.imported).toBe(4);
  });

  it("中止を求めなければ中止を送らない（負例）", async () => {
    let cancels = 0;
    const api = {
      submit: async () => st({ state: "QUEUED" }),
      get: async () => st({ state: "DONE" }),
      cancel: async () => { cancels += 1; },
    };
    await runImportJob(api, ["/a"], () => undefined, () => false, 1, noSleep);
    expect(cancels).toBe(0);
    expect(isFinished(st({ state: "FAILED" }))).toBe(true);
    expect(isFinished(st({ state: "SCANNING" }))).toBe(false);
  });
});
