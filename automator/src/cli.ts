#!/usr/bin/env node
import { Command } from "commander";
import { createDriver, type Mode } from "./driver/index.js";
import { ALL_ITEMS, getItem, getItemsByCategory, getItemsForMode } from "./checklist/registry.js";
import { runItem } from "./runner/runItem.js";
import { checkAll, formatCheckReport } from "./fixtures/checkFixtures.js";
import { resetDb } from "./backend/dbReset.js";
import { recordResult } from "./runner/recorder.js";
import { createStepRecorder } from "./checklist/types.js";
import { writeReport } from "./report/index.js";

const program = new Command();
program.name("automator").description("GRAPHY-Next 自律検証ツール").version("0.1.0");

program
  .command("list")
  .description("実装済み checklist item 一覧")
  .option("--category <cat>", "カテゴリで絞り込む")
  .option("--mode <mode>", "desktop|web で絞り込む")
  .action((opts: { category?: string; mode?: Mode }) => {
    let items = opts.category ? getItemsByCategory(opts.category, opts.mode) : ALL_ITEMS;
    if (opts.mode && !opts.category) items = getItemsForMode(opts.mode);
    if (items.length === 0) {
      console.log("(該当する item はありません)");
      return;
    }
    for (const it of items) {
      console.log(`${it.id}\t[${it.category}]\t(${it.modes.join(",")})\t${it.title}${it.requiresHuman ? " (要人間確認)" : ""}`);
    }
  });

program
  .command("check-fixtures")
  .description("fixture の配置状況を確認する")
  .option("--category <cat>", "カテゴリで絞り込む")
  .action((opts: { category?: string }) => {
    const results = checkAll(opts.category);
    console.log(formatCheckReport(results));
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  });

program
  .command("reset-db")
  .description("backend の症例データを全削除する（Driver を自前起動して呼ぶ）")
  .option("--mode <mode>", "desktop|web", "desktop")
  .action(async (opts: { mode: Mode }) => {
    const driver = createDriver(opts.mode);
    await driver.start();
    try {
      const result = await resetDb(driver.ports.http);
      console.log(JSON.stringify(result));
    } finally {
      await driver.stop();
    }
  });

async function runItems(items: ReturnType<typeof getItemsByCategory>, mode: Mode) {
  if (items.length === 0) {
    console.log("(実行対象なし)");
    return;
  }
  const driver = createDriver(mode);
  await driver.start();
  try {
    for (const item of items) {
      process.stdout.write(`[run] ${item.id} ... `);
      const result = await runItem(item, { driver });
      console.log(result.status);
      if (result.status === "fail") console.log(`  error: ${result.error}`);
      if (result.status === "needs-human") console.log(`  question: ${result.question}\n  screenshot: ${result.screenshotPath}`);
    }
  } finally {
    await driver.stop();
  }
}

program
  .command("run [itemIds...]")
  .description("item を1つ以上（記載順に1セッションで）、または --category 指定で複数項目を実行する")
  .option("--category <cat>", "カテゴリ内の全項目を実行")
  .option("--mode <mode>", "desktop|web", "desktop")
  .action(async (itemIds: string[], opts: { category?: string; mode: Mode }) => {
    if ((!itemIds || itemIds.length === 0) && !opts.category) {
      console.error("item id（1つ以上）か --category のどちらかを指定してください");
      process.exitCode = 1;
      return;
    }
    const items = itemIds && itemIds.length ? itemIds.map(getItem) : getItemsByCategory(opts.category!, opts.mode);
    const runnable = items.filter((it) => it.modes.includes(opts.mode));
    const skipped = items.filter((it) => !it.modes.includes(opts.mode));
    for (const it of skipped) console.log(`[skip] ${it.id} は ${opts.mode} 非対応（modes=${it.modes.join(",")}）`);
    await runItems(runnable, opts.mode);
  });

program
  .command("confirm <itemId>")
  .description("要人間確認の項目を確定する")
  .requiredOption("--pass", "合格として確定")
  .option("--fail", "不合格として確定（--pass と排他）")
  .option("--mode <mode>", "どのモードの結果として確定するか", "desktop")
  .option("--note <note>", "備考")
  .action((itemId: string, opts: { pass?: boolean; fail?: boolean; mode: Mode; note?: string }) => {
    const item = getItem(itemId);
    const recorder = createStepRecorder();
    recorder.step(`人間による確認: ${opts.note ?? "(備考なし)"}`);
    const result = opts.fail
      ? ({ status: "fail", error: opts.note ?? "人間確認でNG" } as const)
      : ({ status: "pass", notes: opts.note } as const);
    recordResult(item, opts.mode, "manual-confirm", result, recorder.steps);
    console.log(`${itemId} (${opts.mode}): ${result.status} として記録しました`);
  });

program
  .command("report")
  .description("checklist の状態を集計し、機能ごとの検証結果を HTML に出力する")
  .option("--mode <mode>", "desktop|web|all", "all")
  .option("--out <path>", "出力先 HTML パス（既定: .results/report.html）")
  .action((opts: { mode: Mode | "all"; out?: string }) => {
    const modes: Mode[] = opts.mode === "all" ? ["desktop", "web"] : [opts.mode];
    const file = writeReport(modes, opts.out);
    console.log(`レポートを出力しました: ${file}`);
  });

program.parseAsync(process.argv);
