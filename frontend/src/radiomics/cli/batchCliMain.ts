/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 束ねる入口（`scripts/build-batch-cli.mjs` が `desktop/batch-cli/run.cjs` にする）。`desktop/batchCli.js` が backend を
 * 起動してから `runCli` を呼ぶ。ここは Node の `fs`・`fetch` を `runBatchCli` に繋ぐだけ。
 */
import fs from "node:fs";
import path from "node:path";
import { cancelBatch, getBatch, getBatchResults, planBatch, submitBatch } from "../batchApi";
import { httpGet, setApiBase } from "./httpNode";
import { runBatchCli, type CliApi, type CliIo, type CliOptions } from "./batchCliRun";

export interface RunCliInput extends CliOptions {
  /** 起動済みの backend の URL（例 `http://127.0.0.1:18080`）。 */
  server: string;
}

export async function runCli(input: RunCliInput): Promise<number> {
  setApiBase(input.server);
  const api: CliApi = {
    albums: () => httpGet("/api/albums"),
    albumStudies: (id) => httpGet(`/api/albums/${id}/studies`),
    plan: (albumId) => planBatch({ albumId, studyUids: null }),
    studies: (uids) => httpGet(`/api/studies?studyInstanceUid=${encodeURIComponent(uids.join(","))}`),
    submit: submitBatch, get: getBatch, results: getBatchResults, cancel: cancelBatch,
  };
  const io: CliIo = {
    readText: (f) => fs.readFileSync(f, "utf8"),
    writeText: (f, t) => fs.writeFileSync(f, t, "utf8"),
    mkdirp: (d) => void fs.mkdirSync(d, { recursive: true }),
    join: (d, n) => path.join(d, n),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date().toISOString(),
  };
  return (await runBatchCli(input, api, io)).code;
}
