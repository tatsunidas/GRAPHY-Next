/*
 * 実機検証用プラグイン（host.compute.runBatch / attach）。
 *
 * automator が window.__batchInput（endpointId・script・items[{key, studyUid, seriesUid}]・attachBatchId）を置いてから起動する。
 * 結果は window.__batch に置く（page.evaluate で読む）。組が届くたびに summary.json（計算機の上でコードが書いたもの）を読み、
 * 受け取り済みの印（markCollected）まで付ける。
 */
export async function activate(host) {
  const input = window.__batchInput || {};
  const run = (window.__batch = { started: null, items: [], outcome: null, collected: [] });
  const onItem = async (item) => {
    const rec = { key: item.key, jobId: item.jobId, attempt: item.attempt, ok: item.ok, status: item.status, error: item.error, errorName: item.errorName, summary: null, files: item.files };
    if (item.ok) {
      const s = await item.readFile("summary.json");
      rec.summary = s ? JSON.parse(new TextDecoder().decode(s)) : null;
    }
    run.items.push(rec);
    if (input.collect) {
      await item.markCollected();
      run.collected.push(item.jobId);
    }
  };
  const common = { onItem, onStarted: (info) => (run.started = info), pollMs: 400 };
  if (input.attachBatchId) {
    run.outcome = await host.compute.attach(input.attachBatchId, { onItem, pollMs: 400 });
    return;
  }
  run.outcome = await host.compute.runBatch(
    {
      endpointId: input.endpointId,
      script: input.script,
      items: input.items.map((i) => ({ key: i.key, inputs: [{ studyUid: i.studyUid, seriesUid: i.seriesUid, format: "npz" }] })),
      timeoutSec: 300,
    },
    common,
  );
}
