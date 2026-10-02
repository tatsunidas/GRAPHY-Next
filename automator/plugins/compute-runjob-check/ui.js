/*
 * 実機検証用プラグイン（H59 host.compute.runJob）。
 *
 * automator が window.__computeInput（studyUid・seriesUid・endpointId）を置いてから起動する。
 * 結果は window.__computeRun に置く（page.evaluate で読む）。
 *
 * 計算機の上では、受け取った npz の SHA-256・形・meta.json を outputs/summary.json に書き、
 * 閾値で作ったマスクを outputs/mask.npy に書く。automator は SHA-256 を同意画面の値と突き合わせる
 * （＝利用者が承認したバイト列がそのまま届いた）。
 */
const SCRIPT = [
  "import hashlib, json, os, numpy as np",
  "raw = open('inputs/0.npz', 'rb').read()",
  "z = np.load('inputs/0.npz')",
  "v = z['volume']",
  "print('__progress__', 0.3, 'loaded')",
  "import time; time.sleep(1.5)  # 画面のポーリング（400ms）が途中の進み具合を必ず拾えるように",
  "mask = (v > 150).astype(np.uint8)",
  "np.save('outputs/mask.npy', mask)",
  "print('__progress__', 0.8, 'saved')",
  "summary = {",
  "    'sha256': hashlib.sha256(raw).hexdigest(),",
  "    'shape': list(v.shape),",
  "    'dtype': str(v.dtype),",
  "    'voxels': int(mask.sum()),",
  "    'spacing': [float(x) for x in z['spacing']],",
  "    'meta': json.loads(bytes(z['meta.json'])),",
  "    'inputs': sorted(os.listdir('inputs')),",
  "}",
  "json.dump(summary, open('outputs/summary.json', 'w'))",
  "print('shape', v.shape)",
].join("\n");

export async function activate(host) {
  const input = window.__computeInput || {};
  const run = (window.__computeRun = {
    started: true,
    hasCompute: !!(host.compute && host.compute.runJob),
    progress: [],
  });
  const r = await host.compute.runJob(
    {
      endpointId: input.endpointId,
      inputs: [{ studyUid: input.studyUid, seriesUid: input.seriesUid, format: "npz" }],
      script: SCRIPT,
      timeoutSec: 300,
    },
    { onProgress: (p, m) => run.progress.push([p, m]) },
  );
  const out = { ok: r.ok, error: r.error, cancelled: r.cancelled };
  if (r.ok) {
    out.jobId = r.jobId;
    out.status = r.status;
    out.stdout = r.stdout;
    out.stderr = r.stderr;
    out.errorValue = r.errorValue;
    out.files = r.files;
    const s = await r.readFile("summary.json");
    out.summary = s ? JSON.parse(new TextDecoder().decode(s)) : null;
    const m = await r.readFile("mask.npy");
    out.maskBytes = m ? m.length : null;
    out.missing = await r.readFile("nope.bin");
  }
  run.outcome = out;
}
