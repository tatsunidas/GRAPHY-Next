import fs from "node:fs";
import path from "node:path";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import type { Mode } from "../driver/types.js";
import { collectMode, type ModeReport } from "./collect.js";
import { renderReport } from "./html.js";

const DEFAULT_OUT = path.join(AUTOMATOR_ROOT, ".results", "report.html");

/** 指定モード群を集計して HTML を書き出し、出力パスを返す。 */
export function writeReport(modes: Mode[], outPath?: string): string {
  const reports: ModeReport[] = modes.map(collectMode);
  const html = renderReport(reports, new Date().toISOString());
  const out = outPath ? path.resolve(outPath) : DEFAULT_OUT;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, "utf8");
  return out;
}
