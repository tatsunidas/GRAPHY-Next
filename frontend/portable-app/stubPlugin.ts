import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { init as lexerInit, parse as lexerParse } from "es-module-lexer";
import { transformWithEsbuild, type Plugin } from "vite";

// ポータブル版は本体の backend・DB・Electron・プラグイン・レポートを持たない。
// 本体の描画核（viewer/SeriesViewer）をそのまま使うため、それらへ触れる「葉」のモジュールだけを
// 差し替える。差し替え先は portable-app/src/shims/<元のパス>.ts（あればその export を優先）。
// shim に無い export は自動スタブ: fetch*/save* などは reject する Promise、他は何もしない関数。
// → 本体コードは 1 行も変えない（本体との挙動差を作らない）。

const STUBBED = [
  "api.ts",
  "http.ts",
  "apiBase.ts",
  "desktopBridge.ts",
  "dbEvents.ts",
  "settings/settingsApi.ts",
  "plugins/",
  "report/",
  "viewer3d/",
];

const ASYNC_NAME = /^(fetch|http|save|post|put|delete|del|upload|encode|run|export|start|load|submit|send|create|update|list|search|import|read|apply|ensure)/;

export function portableStubs(srcRoot: string, shimRoot: string): Plugin {
  const stubbedRel = (file: string): string | null => {
    const rel = path.relative(srcRoot, file).split(path.sep).join("/");
    if (rel.startsWith("..")) return null;
    return STUBBED.some((s) => (s.endsWith("/") ? rel.startsWith(s) : rel === s)) ? rel : null;
  };
  let ready = false;
  return {
    name: "graphy-portable-stubs",
    enforce: "pre",
    async resolveId(source, importer, opts) {
      if (source.startsWith("\0portable-stub:")) return source;
      if (!importer || !/^[./]/.test(source)) return null;
      const r = await this.resolve(source, importer, { ...opts, skipSelf: true });
      if (!r || r.external) return null;
      const file = r.id.split("?")[0];
      if (stubbedRel(file)) return "\0portable-stub:" + file;
      return null;
    },
    async load(id) {
      if (!id.startsWith("\0portable-stub:")) return null;
      if (!ready) {
        await lexerInit;
        ready = true;
      }
      const file = id.slice("\0portable-stub:".length);
      const rel = stubbedRel(file)!;
      const exportsOf = async (p: string, ts: boolean): Promise<string[]> => {
        const src = readFileSync(p, "utf8");
        const js = ts ? (await transformWithEsbuild(src, p, { loader: p.endsWith("x") ? "tsx" : "ts" })).code : src;
        return lexerParse(js)[1].map((e) => e.n).filter((n) => n !== "default");
      };
      const shim = path.join(shimRoot, rel);
      const shimFile = existsSync(shim) ? shim : null;
      const own = new Set(shimFile ? await exportsOf(shimFile, true) : []);
      const names = (await exportsOf(file, true)).filter((n) => !own.has(n));
      const lines: string[] = [`import { stubFn, stubAsync } from ${JSON.stringify(path.join(shimRoot, "..", "stub.ts").split(path.sep).join("/"))};`];
      if (shimFile) lines.push(`export * from ${JSON.stringify(shimFile.split(path.sep).join("/"))};`);
      for (const n of names) {
        lines.push(`export const ${n} = ${ASYNC_NAME.test(n) ? "stubAsync" : "stubFn"}(${JSON.stringify(rel + "#" + n)});`);
      }
      return lines.join("\n");
    },
  };
}
