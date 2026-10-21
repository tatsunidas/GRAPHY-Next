// GPU の搭載メモリ（設定＞描画環境）。Chromium は GPU のメモリ量を返さないので、OS 側の道具に聞く。
// 実装は Linux の NVIDIA（nvidia-smi）だけ。Windows・macOS は実機で出力を確かめられていないので、取らずに null を返す
// （「不明」と表示させる。0 や推測値で埋めない）。設計: fw/render-environment-design.md「GPU メモリ」
// electron を import しない（CI の Desktop ジョブは npm install しない）。

const { execFile } = require("node:child_process");

const MIB = 1024 * 1024;
const NVIDIA_SMI_ARGS = ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"];

/**
 * `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` の出力（1 行 1 GPU、メモリは MiB）を読む。
 * 読めない行は捨て、1 つも読めなければ null。
 * @returns {{name: string, totalBytes: number}[] | null}
 */
function parseNvidiaSmi(text) {
  if (typeof text !== "string") return null;
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.lastIndexOf(",");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const mib = line.slice(i + 1).trim();
    if (!name || !/^\d+$/.test(mib) || Number(mib) <= 0) continue;
    out.push({ name, totalBytes: Number(mib) * MIB });
  }
  return out.length > 0 ? out : null;
}

function runNvidiaSmi() {
  return new Promise((resolve) => {
    // 引数は配列で渡す（shell を通さない）。ドライバが応答しないとき長く待たない
    execFile("nvidia-smi", NVIDIA_SMI_ARGS, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * この機械の GPU のメモリ。取れなければ null。
 * @param {{platform: string, run?: () => Promise<string | null>}} x
 */
async function query({ platform, run = runNvidiaSmi }) {
  if (platform !== "linux") return null;
  try {
    return parseNvidiaSmi(await run());
  } catch {
    return null;
  }
}

module.exports = { NVIDIA_SMI_ARGS, parseNvidiaSmi, query };
