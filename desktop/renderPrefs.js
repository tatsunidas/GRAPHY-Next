// 描画に使う GPU の選択（設定＞描画環境）。ハイブリッド GPU の機械で「高性能 GPU を使う」を選べるようにする。
// 設計: fw/render-environment-design.md「描画に使う GPU の選択」
//
// Electron main が ready の前に読む必要があるので、backend の設定（KV）ではなく、データフォルダの JSON に置く。
// OS ごとに仕組みが違う（どれも GPU プロセスが生まれる前に付ける）:
//   Linux   … PRIME オフロードの環境変数（NVIDIA のみ。Mesa の DRI_PRIME は zink 経由になり遅い恐れがあるので使わない）
//   Windows / macOS … Chromium の回避策 force_high_performance_gpu（ANGLE の既定 GPU を高性能側にする）
// 既定は OS 任せ（auto）。electron を import しない（CI の Desktop ジョブは npm install しない）。

const fs = require("node:fs");
const path = require("node:path");

const FILE = "render-prefs.json";
const VALUES = ["auto", "high"];
const DEFAULTS = { gpu: "auto" };
const HIGH_PERF_SWITCH = "force_high_performance_gpu";
const LINUX_ENV = { __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia" };
const NVIDIA_GPUS_DIR = "/proc/driver/nvidia/gpus";

/** 壊れた・無い・知らない値は既定（auto）に倒す。 */
function parse(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && VALUES.includes(v.gpu)) return { gpu: v.gpu };
  } catch {
    /* 既定に倒す */
  }
  return { ...DEFAULTS };
}

function load(dir) {
  try {
    return parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
}

/** 一時ファイルに書いてから置き換える（途中で落ちても壊れた JSON を残さない）。書けたかを返す。 */
function save(dir, prefs) {
  if (!prefs || !VALUES.includes(prefs.gpu)) return false;
  const file = path.join(dir, FILE);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ gpu: prefs.gpu }), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 後始末の失敗は無視 */
    }
    return false;
  }
}

/** NVIDIA ドライバが見ている GPU の数（Linux）。読めなければ 0。 */
function nvidiaGpuCount(dir = NVIDIA_GPUS_DIR) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * 設定の節を出せるか。GPU が 2 つ以上（ハイブリッド）のときだけ。Linux はさらに NVIDIA ドライバが GPU を持つこと
 * （外付け GPU を外した起動で「選べる」と言わない）。単一 GPU の機械には出さない。
 * @param {{platform: string, devices: unknown[], nvidiaGpuCount: number}} x
 */
function supported({ platform, devices, nvidiaGpuCount: nvidia }) {
  if (!Array.isArray(devices) || devices.length < 2) return false;
  if (platform === "linux") return nvidia > 0;
  return platform === "win32" || platform === "darwin";
}

/**
 * 起動時に付けるもの。auto・対応外では何も付けない。
 * Linux は NVIDIA が見つからないとき付けない（付けると GL の初期化で落ちる恐れがある）。
 * @returns {{env: Record<string,string>, switches: string[]}}
 */
function applyPlan(prefs, { platform, nvidiaPresent }) {
  const none = { env: {}, switches: [] };
  if (!prefs || prefs.gpu !== "high") return none;
  if (platform === "linux") return nvidiaPresent ? { env: { ...LINUX_ENV }, switches: [] } : none;
  if (platform === "win32" || platform === "darwin") return { env: {}, switches: [HIGH_PERF_SWITCH] };
  return none;
}

module.exports = { FILE, VALUES, HIGH_PERF_SWITCH, LINUX_ENV, parse, load, save, nvidiaGpuCount, supported, applyPlan };
