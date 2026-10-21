import { describe, expect, it } from "vitest";
import {
  buildItemOutcome,
  summarize,
  watchBatch,
  type BatchDeps,
  type ComputeBatchItemOutcome,
  type LedgerRow,
} from "./pluginComputeBatchApi";
import { listStoredZipEntries, readStoredZipEntry } from "./pluginComputeApi";

function row(id: string, state: LedgerRow["state"], extra: Partial<LedgerRow> = {}): LedgerRow {
  return { id, batchId: "cb_1", itemKey: id, state, reason: null, errorName: null, errorValue: null, outputsBytes: null, collectedAt: null, ...extra };
}

/** 無圧縮 zip（本体の outputs.zip と同じ作り）。 */
function storedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 255, (n >> 8) & 255];
  const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  for (const [name, text] of Object.entries(files)) {
    const nameB = [...enc.encode(name)];
    const data = [...enc.encode(text)];
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0), ...nameB, ...data];
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameB]);
    parts.push(local);
    offset += local.length;
  }
  const cd = central.flat();
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cd.length), ...u32(offset), ...u16(0)];
  return new Uint8Array([...parts.flat(), ...cd, ...eocd]);
}

function makeDeps(script: LedgerRow[][], extra: Partial<BatchDeps> = {}) {
  let call = 0;
  const calls = { cancel: 0, collected: [] as string[], sleeps: 0 };
  const deps: BatchDeps = {
    listRows: async () => script[Math.min(call++, script.length - 1)],
    fetchLog: async (_id, kind) => (kind === "stdout" ? "hello" : null),
    fetchZip: async () => storedZip({ "mask.txt": "abc", "sub/s.json": "{}" }),
    markCollected: async (id) => void calls.collected.push(id),
    cancelBatch: async () => void calls.cancel++,
    sleep: async () => void calls.sleeps++,
    ...extra,
  };
  return { deps, calls };
}

describe("zip の一覧", () => {
  it("名前とサイズを返し、読み出しと整合する", () => {
    const zip = storedZip({ "a.txt": "12345", "d/b.txt": "xy" });
    expect(listStoredZipEntries(zip)).toEqual([{ name: "a.txt", size: 5 }, { name: "d/b.txt", size: 2 }]);
    expect(new TextDecoder().decode(readStoredZipEntry(zip, "d/b.txt") ?? new Uint8Array())).toBe("xy");
    expect(listStoredZipEntries(new Uint8Array(10))).toEqual([]);
  });
});

describe("1 組の結果の形", () => {
  it("DONE は ok:true・status ok・ファイル一覧と readFile、stdout を持つ", async () => {
    const { deps } = makeDeps([[]]);
    const o = await buildItemOutcome(row("j1", "DONE", { outputsBytes: 10 }), deps);
    expect(o.ok).toBe(true);
    if (!o.ok) throw new Error("unreachable");
    expect(o.status).toBe("ok");
    expect(o.stdout).toBe("hello");
    expect(o.files).toEqual([{ name: "mask.txt", size: 3 }, { name: "sub/s.json", size: 2 }]);
    expect(new TextDecoder().decode((await o.readFile("mask.txt")) ?? new Uint8Array())).toBe("abc");
    expect(await o.readFile("nope")).toBeNull();
    expect(o.key).toBe("j1");
  });

  it("🔴 コードのエラー（code-error）は runJob と同じく ok:true・status error（例外名と値つき）", async () => {
    const { deps } = makeDeps([[]], { fetchLog: async (_i, k) => (k === "traceback" ? "line1\nValueError: boom" : "") });
    const o = await buildItemOutcome(row("j", "FAILED", { reason: "code-error", errorName: "ValueError", errorValue: "boom" }), deps);
    if (!o.ok) throw new Error("expected ok");
    expect(o.status).toBe("error");
    expect(o.errorName).toBe("ValueError");
    expect(o.traceback).toEqual(["line1", "ValueError: boom"]);
  });

  it("それ以外の失敗・中断・中止は ok:false で、理由のコードを返す（中止は cancelled）", async () => {
    const { deps } = makeDeps([[]]);
    expect(await buildItemOutcome(row("a", "FAILED", { reason: "dataset-changed" }), deps)).toMatchObject({ ok: false, error: "dataset-changed" });
    expect(await buildItemOutcome(row("b", "FAILED", { reason: "endpoint-unreachable" }), deps)).toMatchObject({ ok: false, error: "endpoint-unreachable" });
    expect(await buildItemOutcome(row("c", "INTERRUPTED", { reason: "interrupted" }), deps)).toMatchObject({ ok: false, error: "interrupted" });
    expect(await buildItemOutcome(row("d", "CANCELLED"), deps)).toMatchObject({ ok: false, cancelled: true, error: "canceled" });
  });

  it("markCollected は台帳の受け取りの口を呼ぶ", async () => {
    const { deps, calls } = makeDeps([[]]);
    const o = await buildItemOutcome(row("j9", "DONE"), deps);
    await o.markCollected();
    expect(calls.collected).toEqual(["j9"]);
  });

  it("summarize は患者名を持たず、collected は印の有無", () => {
    const s = summarize(row("x", "DONE", { collectedAt: "2026-10-21T00:00:00Z" }));
    expect(s.collected).toBe(true);
    expect(Object.keys(s)).not.toContain("inputs");
    expect(summarize(row("y", "DONE")).collected).toBe(false);
  });
});

describe("見守りのループ", () => {
  it("終わった組から 1 回ずつ onItem を呼び、全部終わると件数つきで返る", async () => {
    const { deps } = makeDeps([
      [row("a", "RUNNING"), row("b", "QUEUED"), row("c", "QUEUED")],
      [row("a", "DONE"), row("b", "RUNNING"), row("c", "QUEUED")],
      [row("a", "DONE"), row("b", "FAILED", { reason: "code-error" }), row("c", "RUNNING")],
      [row("a", "DONE"), row("b", "FAILED", { reason: "code-error" }), row("c", "DONE")],
    ]);
    const seen: string[] = [];
    const progress: number[] = [];
    const out = await watchBatch("cb_1", deps, { pollMs: 100, onItem: (i: ComputeBatchItemOutcome) => seen.push(i.key ?? ""), onProgress: (f) => progress.push(f) });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(out).toMatchObject({ ok: true, counts: { done: 2, failed: 1, total: 3 } });
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress[0]).toBe(0);
  });

  it("🔴 一時停止（走っている組が無い）では、残りを失敗にせず paused で返る", async () => {
    const { deps } = makeDeps([
      [row("a", "FAILED", { reason: "endpoint-unreachable", pausedReason: "endpoint-unreachable" }), row("b", "QUEUED", { pausedReason: "endpoint-unreachable" }), row("c", "QUEUED", { pausedReason: "endpoint-unreachable" })],
    ]);
    const seen: string[] = [];
    const out = await watchBatch("cb_1", deps, { pollMs: 100, onItem: (i) => seen.push(i.key ?? "") });
    expect(out).toMatchObject({ ok: true, paused: true, reason: "endpoint-unreachable", counts: { failed: 1, total: 3 } });
    expect(seen).toEqual(["a"]);
  });

  it("一時停止の印があっても、まだ走っている組があるあいだは待つ", async () => {
    const { deps } = makeDeps([
      [row("a", "RUNNING", { pausedReason: "endpoint-unreachable" }), row("b", "QUEUED")],
      [row("a", "FAILED", { reason: "endpoint-unreachable", pausedReason: "endpoint-unreachable" }), row("b", "QUEUED", { pausedReason: "endpoint-unreachable" })],
    ]);
    const out = await watchBatch("cb_1", deps, { pollMs: 100 });
    expect(out).toMatchObject({ ok: true, paused: true });
  });

  it("abort すると一括の中止を 1 回だけ送り、終わるまで見届けて cancelled で返る", async () => {
    const ac = new AbortController();
    let n = 0;
    const { deps, calls } = makeDeps([[row("a", "RUNNING"), row("b", "QUEUED")]], {
      listRows: async () => {
        n++;
        if (n === 1) {
          ac.abort();
          return [row("a", "RUNNING"), row("b", "QUEUED")];
        }
        return [row("a", "CANCELLED"), row("b", "CANCELLED")];
      },
    });
    const out = await watchBatch("cb_1", deps, { pollMs: 100, signal: ac.signal });
    expect(calls.cancel).toBe(1);
    expect(out).toMatchObject({ ok: true, cancelled: true, counts: { cancelled: 2 } });
  });

  it("attach（skipCollected）は受け取り済みの組を届けない", async () => {
    const { deps } = makeDeps([[row("a", "DONE", { collectedAt: "2026-10-21T00:00:00Z" }), row("b", "DONE"), row("c", "FAILED", { reason: "timeout" })]]);
    const seen: string[] = [];
    const out = await watchBatch("cb_1", deps, { pollMs: 100, skipCollected: true, onItem: (i) => seen.push(i.key ?? "") });
    expect(seen).toEqual(["b", "c"]);
    expect(out).toMatchObject({ ok: true, counts: { done: 2, failed: 1, total: 3 } });
  });

  it("台帳が 3 回続けて読めなければ諦め、1〜2 回なら続ける", async () => {
    let n = 0;
    const flaky = makeDeps([[row("a", "DONE")]], {
      listRows: async () => {
        if (++n <= 2) throw new Error("network");
        return [row("a", "DONE")];
      },
    });
    expect(await watchBatch("cb_1", flaky.deps, { pollMs: 100 })).toMatchObject({ ok: true });
    const dead = makeDeps([[]], { listRows: async () => { throw new Error("down"); } });
    expect(await watchBatch("cb_1", dead.deps, { pollMs: 100 })).toEqual({ ok: false, error: "down" });
  });

  it("行が 0 件（知らない一括）は unknown-batch", async () => {
    const { deps } = makeDeps([[]]);
    expect(await watchBatch("cb_x", deps, { pollMs: 100 })).toEqual({ ok: false, error: "unknown-batch" });
  });

  it("onItem・onProgress が投げても見守りは続く（プラグインの不具合で受け取りを止めない）", async () => {
    const { deps } = makeDeps([[row("a", "DONE"), row("b", "DONE")]]);
    let calls = 0;
    const out = await watchBatch("cb_1", deps, { pollMs: 100, onItem: () => { calls++; throw new Error("plugin bug"); }, onProgress: () => { throw new Error("x"); } });
    expect(calls).toBe(2);
    expect(out).toMatchObject({ ok: true, counts: { done: 2 } });
  });

  it("🔴 再実行の行（attempt 2）は新しい行として届き、件数は組ごとの最新の試行で数える", async () => {
    const { deps } = makeDeps([[
      row("a1", "DONE", { itemKey: "a" }),
      row("b1", "FAILED", { itemKey: "b", reason: "code-error", attempt: 1 }),
      row("b2", "DONE", { itemKey: "b", attempt: 2 }),
    ]]);
    const seen: [string | null, number][] = [];
    const out = await watchBatch("cb_1", deps, { pollMs: 100, onItem: (i) => seen.push([i.key, i.attempt]) });
    expect(seen).toEqual([["a", 1], ["b", 1], ["b", 2]]);
    expect(out).toMatchObject({ ok: true, counts: { done: 2, failed: 0, total: 2 } });
  });

  it("同じ組を 2 回届けない（終わった行を何度読んでも）", async () => {
    const same = [row("a", "DONE"), row("b", "RUNNING")];
    const { deps } = makeDeps([same, same, [row("a", "DONE"), row("b", "DONE")]]);
    const seen: string[] = [];
    await watchBatch("cb_1", deps, { pollMs: 100, onItem: (i) => seen.push(i.key ?? "") });
    expect(seen).toEqual(["a", "b"]);
  });
});
