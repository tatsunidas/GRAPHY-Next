/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `examples/plugin-template/graphy-plugin.d.ts` が本体の契約から取り残されていないかを見る。
 *
 * この `.d.ts` は第三者プラグイン作者がエディタ補完に使う**手書きのコピー**であり、
 * 本体の `pluginTypes.ts` を変えても自動では追随しない。実際 2026-08-21 に
 * **H10（`loadVolume`）と H21（`registerVolumes` / `resampleVolume`）が半年近く漏れていた**
 * ——「host API を足したのに、作者からは存在しないように見える」状態になっていた
 * （`fw/plugin-architecture.md` §7.3 / `fw/subtraction-design.md` §12.0）。
 *
 * 完全な型の同一性までは見ない（テンプレートは意図的に**安定サブセット**で、型名も違う）。
 * 見るのは **「名前が抜けていないか」** だけ。抜けは必ず「作者が使えない」に直結するのに対し、
 * 説明文の差は害が無いため。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const CONTRACT = read("./pluginTypes.ts");
const TEMPLATE = read("../../../examples/plugin-template/graphy-plugin.d.ts");

/** `export interface Name ... {` から、行頭 `}` までを切り出す。 */
function interfaceBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^(export )?interface ${name}\\b`, "m"));
  expect(start, `interface ${name} が見つからない`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}", start);
  expect(end, `interface ${name} の終端が見つからない`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** インターフェース直下（インデント 2）のメンバ名。JSDoc 行や入れ子の型は拾わない。 */
function memberNames(body: string): string[] {
  return [...body.matchAll(/^ {2}([A-Za-z_]\w*)\??:/gm)].map((m) => m[1]);
}

function surfaceLiterals(source: string): string[] {
  const start = source.indexOf("export type PluginSurface");
  expect(start).toBeGreaterThanOrEqual(0);
  const decl = source.slice(start, source.indexOf(";", start));
  return [...decl.matchAll(/"([\w.]+)"/g)].map((m) => m[1]).sort();
}

describe("plugin-template の graphy-plugin.d.ts が本体の契約に追随している", () => {
  it("サーフェス語彙が一致する", () => {
    expect(surfaceLiterals(TEMPLATE)).toEqual(surfaceLiterals(CONTRACT));
  });

  for (const iface of ["PluginHostBase", "Viewer2DPluginHost", "MainScreenPluginHost"]) {
    it(`${iface} のメンバがすべてテンプレートにある`, () => {
      const expected = memberNames(interfaceBody(CONTRACT, iface));
      // 本体側が空になったら、正規表現が壊れている（＝何も検査しない状態）ことを疑う。
      expect(expected.length).toBeGreaterThan(0);
      const actual = new Set(memberNames(interfaceBody(TEMPLATE, iface)));
      const missing = expected.filter((name) => !actual.has(name));
      expect(missing, `テンプレートに無い host API: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("H10 / H21 の型がテンプレートにある", () => {
    // 名前だけの検査だと、メンバはあるのに引数の型が無い（＝補完が効かない）状態を見逃す。
    for (const type of [
      "PluginSeriesRef",
      "PluginVolumeGrid",
      "PluginVolume",
      "PluginVolumeEstimate",
      "PluginRegistrationRequest",
      "PluginRegistrationResult",
    ]) {
      expect(TEMPLATE, `${type} がテンプレートに無い`).toContain(`interface ${type}`);
    }
  });
});
