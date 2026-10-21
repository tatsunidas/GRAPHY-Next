// 描画に使う GPU の選択（設定＞描画環境）。ハイブリッド GPU の機械で「高性能 GPU を使う」を選べるようにする。
// 設計: fw/render-environment-design.md「描画に使う GPU の選択」
//
// Electron main が ready の前に読む必要があるので、backend の設定（KV）ではなく、データフォルダの JSON に置く。
// OS ごとに仕組みが違う（どれも GPU プロセスが生まれる前に付ける）:
//   Linux   … NVIDIA は PRIME オフロードの環境変数（Mesa の DRI_PRIME は NVIDIA では zink 経由になり遅い恐れがあるので使わない）。
//             AMD は Mesa の DRI_PRIME=1（実機が無く未確認。画面に「検証中」と出す）
//   Windows / macOS … Chromium の回避策 force_high_performance_gpu（ANGLE の既定 GPU を高性能側にする）
// 既定は OS 任せ（auto）。electron を import しない（CI の Desktop ジョブは npm install しない）。

const fs = require("node:fs");
const path = require("node:path");

const FILE = "render-prefs.json";
// 選択（FILE）とは別に、「その選択が今使えるか」の状態を持つ。選択は書き換えない（外付け GPU をつなぎ直せば戻せるように）。
//   trying … GPU を付けて起動した直後。GPU プロセスが一定時間健全なら、または正常終了で消す。起動時に残っていれば前回は確定しなかった
//   failed … 使えなかった。ユーザーが［もう一度試す］か選択の変更をするまで残り、残っている間は付けない（落ちる起動を繰り返さない）
const STATE_FILE = "render-gpu-state.json";
// Electron の child-process-gone の reason のうち、GPU が使えなかったと見なすもの（clean-exit・killed は含めない）
const GPU_FAIL_REASONS = ["crashed", "abnormal-exit", "launch-failed", "oom", "integrity-failure"];
const VALUES = ["auto", "high"];
const DEFAULTS = { gpu: "auto" };
const HIGH_PERF_SWITCH = "force_high_performance_gpu";
const LINUX_ENV = { __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia" };
const NVIDIA_GPUS_DIR = "/proc/driver/nvidia/gpus";
const DRM_DIR = "/sys/class/drm";
const LINUX_ENV_AMD = { DRI_PRIME: "1" };
const AMD_VENDOR_ID = "0x1002";

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
 * 表示を担っていない AMD の GPU がある（Linux）。boot_vga=1 は画面を出している側なので除く（オフロード先になりうるのは別の GPU）。
 * 読めなければ false。
 */
function amdGpuPresent(dir = DRM_DIR) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^card\d+$/.test(name)) continue;
      const dev = path.join(dir, name, "device");
      let vendor = "";
      let boot = "";
      try {
        vendor = fs.readFileSync(path.join(dev, "vendor"), "utf8").trim().toLowerCase();
      } catch {
        continue;
      }
      try {
        boot = fs.readFileSync(path.join(dev, "boot_vga"), "utf8").trim();
      } catch {
        /* boot_vga が無いカードは表示を担っていない扱い */
      }
      if (vendor === AMD_VENDOR_ID && boot !== "1") return true;
    }
  } catch {
    /* 読めなければ無い扱い */
  }
  return false;
}

/**
 * 設定の節を出せるか。GPU が 2 つ以上（ハイブリッド）のときだけ。Linux はさらに NVIDIA ドライバが GPU を持つか、
 * 表示を担っていない AMD の GPU があること（外付け GPU を外した起動で「選べる」と言わない）。単一 GPU の機械には出さない。
 * @param {{platform: string, devices: unknown[], nvidiaGpuCount: number, amdPresent?: boolean}} x
 */
function supported({ platform, devices, nvidiaGpuCount: nvidia, amdPresent = false }) {
  if (!Array.isArray(devices) || devices.length < 2) return false;
  if (platform === "linux") return nvidia > 0 || amdPresent;
  return platform === "win32" || platform === "darwin";
}

/**
 * 起動時に付けるもの。auto・対応外では何も付けない。
 * Linux は NVIDIA があれば PRIME（優先）、無ければ AMD の DRI_PRIME=1、どちらも無いとき付けない（付けると GL の初期化で落ちる恐れがある）。
 * @returns {{env: Record<string,string>, switches: string[]}}
 */
function applyPlan(prefs, { platform, nvidiaPresent, amdPresent = false }) {
  const none = { env: {}, switches: [] };
  if (!prefs || prefs.gpu !== "high") return none;
  if (platform === "linux") {
    if (nvidiaPresent) return { env: { ...LINUX_ENV }, switches: [] };
    return amdPresent ? { env: { ...LINUX_ENV_AMD }, switches: [] } : none;
  }
  if (platform === "win32" || platform === "darwin") return { env: {}, switches: [HIGH_PERF_SWITCH] };
  return none;
}

/** 状態ファイル。無い・壊れている・知らない値は null（状態なし）。 */
function parseState(text) {
  try {
    const v = JSON.parse(text);
    if (v && v.status === "trying") return { status: "trying" };
    if (v && v.status === "failed") return { status: "failed", reason: typeof v.reason === "string" ? v.reason : "unknown" };
  } catch {
    /* 状態なしに倒す */
  }
  return null;
}

function loadState(dir) {
  try {
    return parseState(fs.readFileSync(path.join(dir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** state が null なら消す。一時ファイルに書いてから置き換える。書けたか（消せたか）を返す。 */
function saveState(dir, state) {
  const file = path.join(dir, STATE_FILE);
  if (state === null) {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  const tmp = `${file}.tmp`;
  try {
    const body = state.status === "failed" ? { status: "failed", reason: state.reason, at: new Date().toISOString() } : { status: "trying" };
    fs.writeFileSync(tmp, JSON.stringify(body), "utf8");
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

/** child-process-gone の reason が「GPU が使えなかった」に当たるか。 */
function isGpuFailure(reason) {
  return GPU_FAIL_REASONS.includes(reason);
}

/**
 * 起動時の判断（純関数）。選択が high でも、使えないときは付けずに OS の既定で起動し、理由を fallback で返す。
 *   fallback: null（付ける・または選択が auto）／"missing"（GPU が見つからない）／"unconfirmed"（前回の起動が確定しなかった）／"failed"（前回 GPU が使えなかった）
 *   nextState: 呼び出し側が状態ファイルに書く値（"keep" は触らない）
 * continuing … 自分で起動し直した直後の起動（trying は自分が書いたもの。前回の未確定とは見なさない）。
 * @param {{prefs: {gpu: string}, state: {status: string, reason?: string} | null, platform: string, nvidiaPresent: boolean, amdPresent?: boolean, continuing?: boolean}} x
 * @returns {{plan: {env: Record<string,string>, switches: string[]}, fallback: null|string, reason?: string, nextState: null|"keep"|{status: string, reason?: string}}}
 */
function decideStartup({ prefs, state, platform, nvidiaPresent, amdPresent = false, continuing = false }) {
  const none = { env: {}, switches: [] };
  if (!prefs || prefs.gpu !== "high") return { plan: none, fallback: null, nextState: null };
  if (state && state.status === "failed") return { plan: none, fallback: "failed", reason: state.reason, nextState: "keep" };
  if (state && state.status === "trying" && !continuing) {
    return { plan: none, fallback: "unconfirmed", reason: "unconfirmed", nextState: { status: "failed", reason: "unconfirmed" } };
  }
  const plan = applyPlan(prefs, { platform, nvidiaPresent, amdPresent });
  if (plan.switches.length === 0 && Object.keys(plan.env).length === 0) return { plan: none, fallback: "missing", nextState: null };
  return { plan, fallback: null, nextState: { status: "trying" } };
}

/** 実機で効くことを確かめていない経路か（画面に「検証中」と出す）。Linux の NVIDIA だけ実測済み。 */
function unverifiedGpu({ platform, nvidiaPresent }) {
  if (platform === "linux") return !nvidiaPresent;
  return platform === "win32" || platform === "darwin";
}

module.exports = { FILE, STATE_FILE, GPU_FAIL_REASONS, parseState, loadState, saveState, isGpuFailure, decideStartup, VALUES, HIGH_PERF_SWITCH, LINUX_ENV, LINUX_ENV_AMD, parse, load, save, nvidiaGpuCount, amdGpuPresent, supported, applyPlan, unverifiedGpu };
