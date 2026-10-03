/// <reference path="../plugin-template/graphy-plugin.d.ts" />
// @ts-check
/*
 * 外部の計算機（Colab の GPU・Jupyter Server）を使う最小の見本。設計: fw/remote-compute-design.md。
 *
 *   H59 host.compute.runJob   … 本体が匿名化したシリーズ（npz）を送り、Python を実行して outputs/ を受け取る
 *   H65 host.showLabelVolume  … 受け取ったラベルの volume を ROI マネージャに出す
 *   H61 host.compute.status / releaseRuntime … 窓を閉じたら Colab のランタイムを解放するかを本体に聞いてもらう
 *
 * 実用のプラグイン（MONAI Bundle）は公式リポジトリ tatsunidas/graphy-next-plugin-monai を参照。
 */

// 計算機の上で走る Python（同意画面に全文が出る）。HU が 150 を超えるところを 1 にする
const SCRIPT = String.raw`
import json, numpy as np
z = np.load('inputs/0.npz')
v = z['volume']                       # float32 [z, y, x]（CT なら HU）
print('__progress__', 0.5, 'threshold')
np.save('outputs/mask.npy', (v > 150).astype(np.uint8))
try:
    import torch
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
except Exception:
    gpu = None
json.dump({'gpu': gpu, 'shape': list(v.shape), 'spacing': z['spacing'].tolist(),
           'origin': z['origin'].tolist(), 'direction': z['direction'].tolist()}, open('outputs/info.json', 'w'))
`;

/** .npy（uint8・C 順）を読む。 */
function readNpyU8(bytes) {
  const hlen = new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true);
  return bytes.slice(10 + hlen);
}

/** @param {any} host */
export async function activate(host) {
  const target = (host.getTargets?.() ?? []).find((t) => t.kind === "image");
  if (!target) { host.notify("画像のタイルを選んでから開いてください"); return; }
  const win = host.openWindow({ title: "Remote compute demo", width: 420, height: 200 });
  const status = document.createElement("div");
  status.style.cssText = "font: 13px system-ui, sans-serif; padding: 12px";
  win.container.append(status);
  let used = false;
  // H61: 閉じたら、この窓で使った Colab のランタイムを解放するかを本体に聞いてもらう
  win.onClose(async () => {
    if (!used) return;
    for (const e of await host.compute.status()) {
      if (e.kind === "colab" && e.runtime?.allocated) await host.compute.releaseRuntime(e.id, { ask: true });
    }
  });

  status.textContent = "送っています…（同意画面が出ます）";
  used = true;
  const r = await host.compute.runJob(
    { inputs: [{ studyUid: target.studyUid, seriesUid: target.seriesUid, format: "npz" }], script: SCRIPT, timeoutSec: 600 },
    { onProgress: (p, m) => { status.textContent = `${Math.round(p * 100)}% ${m ?? ""}`; } },
  );
  if (!r.ok) { status.textContent = r.cancelled ? "取り消しました" : `失敗: ${r.error}`; return; }
  if (r.status !== "ok") { status.textContent = `失敗: ${r.errorName}: ${r.errorValue}`; return; }
  const info = JSON.parse(new TextDecoder().decode(await r.readFile("info.json")));
  const mask = readNpyU8(await r.readFile("mask.npy"));

  // npz は位置の順（法線方向に昇順）。本体の loadVolume の並びに合わせる（逆順なら裏返す）
  const vol = await host.loadVolume({ studyUid: target.studyUid, seriesUid: target.seriesUid });
  const [nx, ny, nz] = vol.dims;
  const nxy = nx * ny;
  const n = info.direction[2];
  const reversed = vol.sliceStep[0] * n[0] + vol.sliceStep[1] * n[1] + vol.sliceStep[2] * n[2] < 0;
  const data = new Uint8Array(nxy * nz);
  for (let k = 0; k < nz; k++) data.set(mask.subarray(k * nxy, (k + 1) * nxy), (reversed ? nz - 1 - k : k) * nxy);

  // H65: ROI マネージャに出す（保存はしない。保存するなら saveSegmentation の labels）
  const shown = await host.showLabelVolume(target.tileId, {
    grid: { dims: vol.dims, ipp: vol.ipp, sliceStep: vol.sliceStep },
    data,
    table: [{ value: 1, label: "HU > 150", color: [255, 200, 0] }],
    label: "Remote compute demo",
  });
  status.textContent = shown.ok
    ? `できました（${info.gpu ?? "CPU"}）。ROI マネージャに読み込みました。`
    : `ROI マネージャに読み込めませんでした: ${shown.error}`;
}
