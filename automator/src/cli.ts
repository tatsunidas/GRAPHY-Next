#!/usr/bin/env node
import { Command } from "commander";
import { createDriver, type Mode } from "./driver/index.js";
import { ALL_ITEMS, getItem, getItemsByCategory } from "./checklist/registry.js";
import { runItem } from "./runner/runItem.js";
import { checkAll, formatCheckReport } from "./fixtures/checkFixtures.js";
import { resetDb } from "./backend/dbReset.js";
import { recordResult } from "./runner/recorder.js";
import { createStepRecorder } from "./checklist/types.js";

const program = new Command();
program.name("automator").description("GRAPHY-Next 自律検証ツール").version("0.1.0");

program
  .command("list")
  .description("実装済み checklist item 一覧")
  .option("--category <cat>", "カテゴリで絞り込む")
  .action((opts: { category?: string }) => {
    const items = opts.category ? getItemsByCategory(opts.category) : ALL_ITEMS;
    if (items.length === 0) {
      console.log("(該当する item はありません)");
      return;
    }
    for (const it of items) {
      console.log(`${it.id}\t[${it.category}]\t${it.title}${it.requiresHuman ? " (要人間確認)" : ""}`);
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
  .command("run [itemId]")
  .description("1項目、または --category 指定で複数項目を実行する")
  .option("--category <cat>", "カテゴリ内の全項目を実行")
  .option("--mode <mode>", "desktop|web", "desktop")
  .action(async (itemId: string | undefined, opts: { category?: string; mode: Mode }) => {
    if (!itemId && !opts.category) {
      console.error("item id か --category のどちらかを指定してください");
      process.exitCode = 1;
      return;
    }
    const items = itemId ? [getItem(itemId)] : getItemsByCategory(opts.category!);
    await runItems(items, opts.mode);
  });

program
  .command("confirm <itemId>")
  .description("要人間確認の項目を確定する")
  .requiredOption("--pass", "合格として確定")
  .option("--fail", "不合格として確定（--pass と排他）")
  .option("--note <note>", "備考")
  .action((itemId: string, opts: { pass?: boolean; fail?: boolean; note?: string }) => {
    const item = getItem(itemId);
    const recorder = createStepRecorder();
    recorder.step(`人間による確認: ${opts.note ?? "(備考なし)"}`);
    const result = opts.fail
      ? ({ status: "fail", error: opts.note ?? "人間確認でNG" } as const)
      : ({ status: "pass", notes: opts.note } as const);
    recordResult(item, "manual-confirm", result, recorder.steps);
    console.log(`${itemId}: ${result.status} として記録しました`);
  });

program.parseAsync(process.argv);
