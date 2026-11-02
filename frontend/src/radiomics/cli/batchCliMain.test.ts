/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSpec, defaultSpecContent, specText } from "../batchSpec";
import { checkSpecFiles } from "./batchCliMain";
import { loadSpecs } from "./batchCliRun";

let dir = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bcm-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function writeSpec(name: string, prefix: string, tamper = false): Promise<string> {
  const spec = await buildSpec(defaultSpecContent(), prefix);
  const file = path.join(dir, name);
  if (tamper) {
    const raw = JSON.parse(specText(spec)) as { form: { binCount: number } };
    raw.form.binCount += 1;
    fs.writeFileSync(file, JSON.stringify(raw));
  } else {
    fs.writeFileSync(file, specText(spec));
  }
  return file;
}

describe("定義ファイルの起動前検査（backend に繋がない）", () => {
  it("有効な定義は 0、改変・読めない・接頭辞の重複・定義なしは 3", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const a = await writeSpec("a.json", "ra");
      const b = await writeSpec("b.json", "rb");
      const dup = await writeSpec("dup.json", "ra");
      const bad = await writeSpec("bad.json", "rbad", true);
      expect(await checkSpecFiles([a, b])).toBe(0);
      expect(await checkSpecFiles([a, bad])).toBe(3);
      expect(await checkSpecFiles([a, path.join(dir, "none.json")])).toBe(3);
      expect(await checkSpecFiles([a, dup])).toBe(3);
      expect(await checkSpecFiles([])).toBe(3);
      expect(err.mock.calls.flat().join("\n")).toContain("sha_mismatch");
    } finally {
      err.mockRestore();
    }
  });

  it("loadSpecs は問題を全部集める（最初の 1 件で止めない）", async () => {
    const a = await writeSpec("c.json", "rc");
    const bad = await writeSpec("bad2.json", "rbad2", true);
    const r = await loadSpecs([bad, path.join(dir, "none2.json"), a], { readText: (f) => fs.readFileSync(f, "utf8") });
    expect(r.loaded.map((l) => l.file)).toEqual([a]);
    expect(r.problems).toHaveLength(2);
  });
});
