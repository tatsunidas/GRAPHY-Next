// この PC の Python と GPU を見分ける（見て出すだけ）。設計: fw/remote-compute-design.md「この PC の Python と GPU の検出」
//
// 🔴 本体は pip・conda を一度も呼ばない。足りないものは名前とコピー用のコマンドで案内するだけ。
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。
// 🔴 外部プロセスは execFile に配列で渡し、shell は使わない。renderer から来た文字列は引数に入らない。
//    Python のパスを文字列で受ける口は作らない（指定は main のファイル選択 → 確認を通ったものだけ保存される）。
//
// 構成: 純関数（candidates / parseProbe / parseNvidiaSmi / judge / rank / guidance / childEnv）と、
//       副作用（detect / cancel）。純関数はファイルの有無を引数で受けるので、OS ごとの表で試せる。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const PROBE_MARKER = "__graphy_local_probe__";
const PYTORCH_INSTALL_URL = "https://pytorch.org/get-started/locally/";
const NVIDIA_QUERY = ["--query-gpu=name,memory.total,driver_version,uuid", "--format=csv,noheader,nounits"];

/**
 * 候補の Python で動かす固定の確認コード（`python -c`）。.py を別に置かない＝配布物の載せ忘れを起こさない。
 *
 * - バージョンは importlib.metadata で取り、import しない（jupyter_server の import は遅い）。torch だけは import する。
 * - 例外はすべて結果の欄に文字列で入れ、確認自体は落とさない。
 * - 引用符は単一引用符だけ・バックスラッシュ無し（Windows のコマンド行を通る形）。
 * - 作業フォルダ（cwd）は本体専用の空フォルダ。`-c` は cwd を sys.path[0] に入れるので、
 *   同名モジュールを読まない守りは cwd が空であることから来る。`-I` は使わない（利用者の site-packages の torch を隠して判定を誤る）。
 */
const PROBE = [
  "import sys, os, json",
  "r = {'schema': 1}",
  "def _try(f, d=None):",
  "    try:",
  "        return f()",
  "    except Exception:",
  "        return d",
  "def _ver(*names):",
  "    try:",
  "        from importlib import metadata as m",
  "    except Exception:",
  "        return None",
  "    for n in names:",
  "        v = _try(lambda: m.version(n))",
  "        if v:",
  "            return v",
  "    return None",
  "r['executable'] = sys.executable",
  "r['version'] = '%d.%d.%d' % tuple(sys.version_info[:3])",
  "r['prefix'] = sys.prefix",
  "bp = getattr(sys, 'base_prefix', sys.prefix)",
  "r['venv'] = (sys.prefix != bp) or hasattr(sys, 'real_prefix')",
  "r['conda'] = os.path.isdir(os.path.join(sys.prefix, 'conda-meta'))",
  "def _em():",
  "    import sysconfig",
  "    return os.path.isfile(os.path.join(sysconfig.get_path('stdlib'), 'EXTERNALLY-MANAGED'))",
  "r['externallyManaged'] = (not r['venv']) and bool(_try(_em, False))",
  "r['jupyterServer'] = _ver('jupyter_server', 'jupyter-server')",
  "r['ipykernel'] = _ver('ipykernel')",
  "r['torchVersion'] = _ver('torch')",
  "if r['torchVersion']:",
  "    t = {}",
  "    try:",
  "        import torch",
  "        t['version'] = str(torch.__version__)",
  "        t['cuda'] = _try(lambda: torch.version.cuda)",
  "        t['available'] = bool(_try(lambda: torch.cuda.is_available(), False))",
  "        t['archList'] = _try(lambda: list(torch.cuda.get_arch_list()), [])",
  "        t['mps'] = bool(_try(lambda: torch.backends.mps.is_available(), False))",
  "        devs = []",
  "        if t['available']:",
  "            for i in range(torch.cuda.device_count()):",
  "                d = {'name': _try(lambda: torch.cuda.get_device_name(i))}",
  "                d['totalMemory'] = _try(lambda: int(torch.cuda.get_device_properties(i).total_memory))",
  "                d['capability'] = _try(lambda: list(torch.cuda.get_device_capability(i)))",
  "                u = _try(lambda: getattr(torch.cuda.get_device_properties(i), 'uuid', None))",
  "                if u is not None:",
  "                    d['uuid'] = str(u)",
  "                devs.append(d)",
  "        t['devices'] = devs",
  "    except Exception as e:",
  "        t['error'] = '%s: %s' % (type(e).__name__, e)",
  "    r['torch'] = t",
  `print('${PROBE_MARKER}' + json.dumps(r))`,
].join("\n");

// ── 純関数 ───────────────────────────────────────────────────────────────

const pathModule = (platform) => (platform === "win32" ? path.win32 : path.posix);

const WINDOWS_APPS_RE = /[\\/]windowsapps[\\/]/i;

function envGet(env, name, platform) {
  if (!env) return undefined;
  if (platform !== "win32") return env[name];
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : env[k];
}

function pathDirs(env, platform) {
  const raw = envGet(env, "PATH", platform) || "";
  const delim = platform === "win32" ? ";" : ":";
  return raw.split(delim).map((s) => s.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

/**
 * OS ごとの決まった順で Python の候補を集める（起動はしない・ファイルの有無だけ）。
 * 除外したもの（WindowsApps の代役・CLT の無い macOS の /usr/bin/python3）も理由つきで返し、探した場所も返す。
 *
 * @param o.platform  "win32" | "darwin" | "linux"
 * @param o.env       process.env 相当
 * @param o.homedir   ホーム
 * @param o.exists    (p) => 通常ファイルがあるか
 * @param o.setting   { mode: "auto" } | { mode: "path", path }
 * @param o.pyList    Windows: `py -0p` の結果 [{ path, isDefault }]（detect が先に取る）
 * @param o.cltInstalled  macOS: `xcode-select -p` が成功したか
 * @param o.condaEnvPrefixes  Linux: ~/.conda/environments.txt の prefix
 * @returns {{candidates: {path:string, source:string, status:"candidate"|"excluded", reasons:string[]}[], searched:string[]}}
 */
function candidates(o) {
  const platform = o.platform;
  const P = pathModule(platform);
  const win = platform === "win32";
  const searched = [];
  const out = [];
  const seenDirs = new Set();
  const dirKey = (p) => (win ? P.dirname(p).toLowerCase() : P.dirname(p));

  const setting = o.setting && o.setting.mode === "path" ? o.setting : null;
  if (setting) {
    // 設定したパスがあれば、ほかは探さない
    searched.push(setting.path);
    const reasons = [];
    let status = "candidate";
    if (win && !/\.exe$/i.test(setting.path)) {
      status = "excluded";
      reasons.push("excluded-not-exe");
    } else if (win && WINDOWS_APPS_RE.test(setting.path)) {
      status = "excluded";
      reasons.push("excluded-windowsapps");
    } else if (!o.exists(setting.path)) {
      status = "excluded";
      reasons.push("setting-not-found");
    }
    return { candidates: [{ path: setting.path, source: "setting", status, reasons }], searched };
  }

  /** 除外の理由（空なら候補にできる）。 */
  const exclusion = (p) => {
    if (win && !/\.exe$/i.test(p)) return ["excluded-not-exe"];
    if (win && WINDOWS_APPS_RE.test(p)) return ["excluded-windowsapps"];
    if (platform === "darwin" && p === "/usr/bin/python3" && !o.cltInstalled) return ["excluded-no-clt"];
    return [];
  };

  /** 候補を足す。同じフォルダ＝同じ環境は 1 つだけ。 */
  const add = (p, source) => {
    const reasons = exclusion(p);
    if (reasons.length > 0) {
      if (!out.some((c) => c.path === p)) out.push({ path: p, source, status: "excluded", reasons });
      return false;
    }
    const k = dirKey(p);
    if (seenDirs.has(k)) return false;
    seenDirs.add(k);
    out.push({ path: p, source, status: "candidate", reasons: [] });
    return true;
  };

  // ① Windows の py ランチャ（既定が先頭）
  if (win) {
    searched.push("py -0p");
    const list = [...(o.pyList || [])].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
    for (const e of list) add(e.path, "py-launcher");
  }

  // ② PATH 上の python
  const dirs = pathDirs(o.env, platform);
  if (platform === "darwin") {
    // Finder から起動した Electron の PATH は /usr/bin:/bin:/usr/sbin:/sbin だけのことが多い
    for (const extra of ["/opt/homebrew/bin", "/usr/local/bin"]) if (!dirs.includes(extra)) dirs.push(extra);
  }
  const names = win ? [["python.exe"]] : [["python3"], ["python"]];
  for (const group of names) {
    let took = false;
    for (const dir of dirs) {
      for (const name of group) {
        const p = P.join(dir, name);
        searched.push(p);
        if (!o.exists(p)) continue;
        // 最初に見つかった非除外の 1 本が `python3` の指す先。除外されるものは（理由を見せるため）常に載せる
        if (took && exclusion(p).length === 0) continue;
        if (add(p, "path")) took = true;
      }
    }
    if (took) break; // python3 が見つかれば python は探さない
  }
  if (platform === "darwin") {
    searched.push("/usr/bin/python3");
    if (o.exists("/usr/bin/python3")) add("/usr/bin/python3", "path");
  }

  // ③ conda の base（`condabin/conda` がある prefix。`conda create -p` の環境や envs/ の下は base ではない）
  const home = o.homedir;
  const names3 = ["anaconda3", "miniconda3", "miniforge3"];
  const prefixes = [];
  if (win) {
    for (const root of [home, envGet(o.env, "LOCALAPPDATA", platform), envGet(o.env, "ProgramData", platform)]) {
      if (root) for (const n of names3) prefixes.push(P.join(root, n));
    }
  } else if (platform === "darwin") {
    for (const n of ["miniforge3", "miniconda3", "anaconda3"]) prefixes.push(P.join(home, n));
    prefixes.push("/opt/homebrew/Caskroom/miniforge/base", "/opt/anaconda3", "/opt/miniconda3");
  } else {
    for (const n of ["miniforge3", "miniconda3", "anaconda3"]) prefixes.push(P.join(home, n));
    prefixes.push("/opt/conda", "/opt/anaconda3", "/opt/miniconda3");
    for (const p of o.condaEnvPrefixes || []) if (typeof p === "string" && P.isAbsolute(p)) prefixes.push(p);
  }
  const seenPrefix = new Set();
  for (const prefix of prefixes) {
    if (seenPrefix.has(prefix)) continue;
    seenPrefix.add(prefix);
    const py = win ? P.join(prefix, "python.exe") : P.join(prefix, "bin", "python");
    searched.push(py);
    const condaCmd = win ? P.join(prefix, "condabin", "conda.bat") : P.join(prefix, "condabin", "conda");
    if (!o.exists(py) || !o.exists(condaCmd)) continue;
    add(py, "conda-base");
  }
  return { candidates: out, searched };
}

/** 確認コードの出力から、最終行の印つき JSON を取り出す。 */
function parseProbe(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith(PROBE_MARKER)) continue;
    try {
      const v = JSON.parse(line.slice(PROBE_MARKER.length));
      if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, probe: v };
    } catch {
      /* 下で probe-unparsable */
    }
    break;
  }
  return { ok: false, reason: "probe-unparsable" };
}

/** `--query-gpu=name,memory.total,driver_version,uuid --format=csv,noheader,nounits` の出力。 */
function parseNvidiaSmi(stdout) {
  const gpus = [];
  let unparsed = 0;
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 4) {
      unparsed++;
      continue;
    }
    // 名前に , が入っても、末尾の 3 欄から数える
    const [memory, driver, uuid] = f.slice(-3);
    const name = f.slice(0, -3).join(", ");
    const mem = /^\d+$/.test(memory) ? Number(memory) : null;
    if (!name) {
      unparsed++;
      continue;
    }
    gpus.push({ name, memoryMiB: mem, driver: driver || null, uuid: uuid || null });
  }
  return { gpus, unparsed };
}

/**
 * デバイスの計算能力 [M, m] が、そのビルドの arch list に含まれるか。
 * `sm_<M><m'>`（同じ M で m' ≤ m）か `compute_<XY>`（XY ≤ デバイス）があれば含まれる（CUDA のバイナリ互換と PTX の規則）。
 * 文字つき（sm_90a など）は同じ能力のときだけ。arch list が空・能力が不明なら null（判定できない）。
 * 🔴 この規則が実際の PyTorch の動作と合うかは Pascal の実機で確かめるまで未確認。
 */
function archSupported(capability, archList) {
  if (!Array.isArray(capability) || capability.length < 2 || !Array.isArray(archList) || archList.length === 0) return null;
  const M = Number(capability[0]);
  const m = Number(capability[1]);
  if (!Number.isInteger(M) || !Number.isInteger(m)) return null;
  const dev = M * 10 + m;
  for (const a of archList) {
    const sm = /^sm_(\d+)([a-z]?)$/.exec(a);
    if (sm) {
      const n = Number(sm[1]);
      const aM = Math.floor(n / 10);
      const am = n % 10;
      if (sm[2]) {
        if (n === dev) return true;
      } else if (aM === M && am <= m) return true;
      continue;
    }
    const cp = /^compute_(\d+)$/.exec(a);
    if (cp && Number(cp[1]) <= dev) return true;
  }
  return false;
}

const normUuid = (u) => String(u || "").replace(/^GPU-/i, "").toLowerCase();

/**
 * 判定。「GPU あり」＝その PyTorch が CUDA を使え、かつ GPU の世代がそのビルドに含まれる。
 * nvidia-smi に出るだけでは数えない。MPS は表示するが数えない。
 *
 * @param probe   parseProbe の probe
 * @param nvidia  { found, gpus }（nvidia-smi の結果）
 * @returns {{reasons:string[], missing:string[], capabilities:object, hasServer:boolean, hasKernel:boolean, cudaUsable:boolean}}
 */
function judge(probe, nvidia) {
  const reasons = [];
  const missing = [];
  const smiGpus = (nvidia && nvidia.found && nvidia.gpus) || [];
  const hasServer = !!probe.jupyterServer;
  const hasKernel = !!probe.ipykernel;
  if (!hasServer) {
    reasons.push("missing-jupyter-server");
    missing.push("jupyter_server");
  }
  if (!hasKernel) {
    reasons.push("missing-ipykernel");
    missing.push("ipykernel");
  }
  const torch = probe.torch || null;
  const driver = smiGpus.length > 0 ? smiGpus[0].driver : null;
  const caps = {
    accelerator: "cpu",
    devices: [],
    torch: probe.torchVersion || null,
    cudaRuntime: (torch && torch.cuda) || null,
    driver,
  };
  let cudaUsable = false;
  if (!probe.torchVersion) {
    reasons.push("no-torch");
    missing.push("torch");
  } else if (!torch || torch.error) {
    reasons.push("torch-import-failed");
  } else {
    const tdevs = torch.available && Array.isArray(torch.devices) ? torch.devices : [];
    // nvidia-smi と torch のデバイスを突き合わせる（uuid → 名前の順）
    const used = new Set();
    const pair = (g) => {
      let j = -1;
      if (g.uuid) j = tdevs.findIndex((d, i) => !used.has(i) && d.uuid && normUuid(d.uuid) === normUuid(g.uuid));
      if (j < 0) j = tdevs.findIndex((d, i) => !used.has(i) && d.name === g.name);
      if (j >= 0) used.add(j);
      return j >= 0 ? tdevs[j] : null;
    };
    const devices = [];
    for (const g of smiGpus) {
      const d = pair(g);
      devices.push({
        name: g.name,
        memoryMiB: g.memoryMiB,
        memoryBytes: d && Number.isFinite(d.totalMemory) ? d.totalMemory : null,
        capability: d && Array.isArray(d.capability) ? d.capability : null,
        archSupported: d ? archSupported(d.capability, torch.archList) : null,
        torchDevice: !!d,
      });
    }
    tdevs.forEach((d, i) => {
      if (used.has(i)) return;
      devices.push({
        name: d.name || null,
        memoryMiB: null,
        memoryBytes: Number.isFinite(d.totalMemory) ? d.totalMemory : null,
        capability: Array.isArray(d.capability) ? d.capability : null,
        archSupported: archSupported(d.capability, torch.archList),
        torchDevice: true,
      });
    });
    caps.devices = devices;
    if (torch.available) {
      const unsupported = devices.some((d) => d.torchDevice && d.archSupported === false);
      cudaUsable = devices.some((d) => d.torchDevice && d.archSupported !== false);
      if (unsupported) reasons.push("gpu-arch-unsupported");
      if (cudaUsable) caps.accelerator = "cuda";
      if (smiGpus.length === 0) reasons.push("nvidia-smi-missing");
    } else if (smiGpus.length > 0) {
      reasons.push(torch.cuda ? "driver-maybe-old" : "torch-cpu-build");
    }
    if (torch.mps) {
      reasons.push("mps-available");
      if (!cudaUsable) caps.accelerator = "mps";
    }
  }
  if (probe.externallyManaged && missing.length > 0) reasons.push("externally-managed");
  if (caps.accelerator === "cpu" && !cudaUsable) {
    // nvidia-smi の GPU は「見つかったが使えない」ので、名前と VRAM だけ記録に残す
    if (caps.devices.length === 0) {
      caps.devices = smiGpus.map((g) => ({
        name: g.name, memoryMiB: g.memoryMiB, memoryBytes: null, capability: null, archSupported: null, torchDevice: false,
      }));
    }
  }
  return { reasons, missing, capabilities: caps, hasServer, hasKernel, cudaUsable };
}

/**
 * 揃い具合で 1 つ選ぶ。① jupyter_server＋ipykernel＋CUDA 可の torch → ② jupyter_server＋ipykernel → ③ 足りない。
 * 同じ段なら候補の順。MPS は ① に数えない。PROBE が失敗した候補は選ばない。
 * ③ しか無いときも、いちばん揃っているものを（案内の対象として）返す。
 * @param results  [{ probed: boolean, judged }]（候補の順）
 * @returns {{index:number, tier:1|2|3}|null}
 */
function rank(results) {
  let best = null;
  results.forEach((r, i) => {
    if (!r || !r.probed || !r.judged) return;
    const j = r.judged;
    let tier;
    let score = 0;
    if (j.hasServer && j.hasKernel) tier = j.cudaUsable ? 1 : 2;
    else {
      tier = 3;
      score = Number(j.hasServer) + Number(j.hasKernel);
    }
    if (!best || tier < best.tier || (tier === best.tier && tier === 3 && score > best.score)) best = { index: i, tier, score };
  });
  return best ? { index: best.index, tier: best.tier } : null;
}

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * 足りないときの案内（文字列）。PyTorch は CUDA の版と OS で入れ方が変わるので、コマンドは出さず公式の選び方のページへ。
 * Windows は PowerShell 形を主に、cmd 形も併記。
 */
function guidance(candidate, judged, platform) {
  const out = { missing: [], commands: [], links: [] };
  if (!candidate || !judged) return out;
  out.missing = [...judged.missing];
  const py = candidate.path;
  const pkgs = judged.missing.filter((m) => m !== "torch");
  if (pkgs.length > 0) {
    const names = pkgs.join(" ");
    if (judged.reasons.includes("externally-managed")) {
      // venv でない OS 付属の Python では pip が断る。環境を作ってそのパスを設定してもらう
      out.commands.push({ shell: "sh", text: `${shQuote(py)} -m venv "$HOME/graphy-compute-venv"` });
      out.commands.push({ shell: "sh", text: `"$HOME/graphy-compute-venv/bin/python" -m pip install ${names}` });
    } else if (platform === "win32") {
      out.commands.push({ shell: "powershell", text: `& "${py}" -m pip install ${names}` });
      out.commands.push({ shell: "cmd", text: `"${py}" -m pip install ${names}` });
    } else {
      out.commands.push({ shell: "sh", text: `${shQuote(py)} -m pip install ${names}` });
    }
    if (candidate.source === "conda-base" && !judged.reasons.includes("externally-managed")) {
      out.commands.push({ shell: platform === "win32" ? "cmd" : "sh", text: `conda install -c conda-forge ${names}` });
    }
  }
  if (judged.reasons.some((r) => ["no-torch", "torch-cpu-build", "driver-maybe-old", "gpu-arch-unsupported"].includes(r))) {
    out.links.push(PYTORCH_INSTALL_URL);
  }
  return out;
}

/** 子プロセスの環境。GRAPHY_*（本体の内部経路の秘密など）と ELECTRON_* を除く。PYTHONPATH などは利用者の環境として残す。 */
function childEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (/^(GRAPHY_|ELECTRON_)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** nvidia-smi を探す場所（PATH と、Windows はドライバの置き場所）。 */
function nvidiaSmiPaths({ platform, env }) {
  const P = pathModule(platform);
  const exe = platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
  const list = pathDirs(env, platform).map((d) => P.join(d, exe));
  if (platform === "win32") {
    const sysRoot = envGet(env, "SystemRoot", platform);
    const pf = envGet(env, "ProgramFiles", platform);
    if (sysRoot) list.push(P.join(sysRoot, "System32", exe));
    if (pf) list.push(P.join(pf, "NVIDIA Corporation", "NVSMI", exe));
  }
  return list;
}

/**
 * 保存してよい Python のパスか（絶対パス・NUL なし・Windows は .exe で WindowsApps でない）。通常ファイルかどうかは呼び出し側が isFile で。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
function validatePythonPath(p, { platform = process.platform } = {}) {
  if (typeof p !== "string" || !p) return { ok: false, reason: "path-missing" };
  if (p.includes("\0")) return { ok: false, reason: "path-nul" };
  if (p.length > 1024) return { ok: false, reason: "path-too-long" };
  const P = pathModule(platform);
  if (!P.isAbsolute(p)) return { ok: false, reason: "path-not-absolute" };
  if (p.split(/[\\/]/).includes("..")) return { ok: false, reason: "path-has-dotdot" };
  if (platform === "win32" && !/\.exe$/i.test(p)) return { ok: false, reason: "path-not-exe" };
  if (platform === "win32" && WINDOWS_APPS_RE.test(p)) return { ok: false, reason: "path-windowsapps" };
  return { ok: true };
}

/** `py -0p` の出力（`-V:3.12 *   C:\...\python.exe` / `-3.12-64 *  C:\...`）。形は実機で未確認なので緩く読む。 */
function parsePyList(stdout) {
  const list = [];
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const m = /^\s*-\S+\s+(\*)?\s*(.+?\.exe)\s*$/i.exec(raw);
    if (m) list.push({ path: m[2].trim(), isDefault: !!m[1] });
  }
  return list;
}

// ── 副作用 ───────────────────────────────────────────────────────────────

/** execFile の Promise 版。取り消し・起動失敗・非 0 終了・出力超過を分けて返す。 */
function run(execFile, file, args, opts) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    try {
      execFile(file, args, { ...opts, shell: false, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
        const elapsedMs = Date.now() - t0;
        if (!err) return resolve({ ok: true, stdout: String(stdout), stderr: String(stderr), elapsedMs });
        if (err.name === "AbortError" || err.code === "ABORT_ERR") return resolve({ ok: false, aborted: true, elapsedMs });
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ ok: false, reason: "probe-output-too-large", elapsedMs });
        }
        if (typeof err.code === "number") {
          return resolve({ ok: false, reason: `exit:${err.code}`, stdout: String(stdout || ""), stderr: String(stderr || ""), elapsedMs });
        }
        if (err.signal) return resolve({ ok: false, reason: `killed:${err.signal}`, elapsedMs });
        resolve({ ok: false, reason: `spawn-failed:${err.code || err.message}`, elapsedMs });
      });
    } catch (e) {
      resolve({ ok: false, reason: `spawn-failed:${(e && e.code) || (e && e.message)}`, elapsedMs: Date.now() - t0 });
    }
  });
}

/**
 * 検出器を作る。deps は試験で差し替える。
 * @param deps.getSetting  () => { mode, path? }
 * @param deps.probeDir    確認コードの作業フォルダ（本体専用の空フォルダ）
 */
function createDetector(deps) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const execFile = deps.execFile || childProcess.execFile;
  const homedir = deps.homedir || os.homedir();
  const isFile = deps.isFile || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const readFile = deps.readFile || ((p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } });
  const mkdir = deps.mkdir || ((p) => fs.mkdirSync(p, { recursive: true }));

  let cache = null;
  let inflight = null;
  let abort = null;

  async function detectNvidia(signal) {
    const tried = nvidiaSmiPaths({ platform, env });
    const found = tried.find((p) => isFile(p));
    if (!found) return { found: false, gpus: [], searched: tried };
    const r = await run(execFile, found, NVIDIA_QUERY, { env: childEnv(env), cwd: deps.probeDir, signal });
    if (r.aborted) return { aborted: true };
    if (!r.ok) return { found: true, path: found, gpus: [], error: r.reason, elapsedMs: r.elapsedMs };
    const parsed = parseNvidiaSmi(r.stdout);
    return { found: true, path: found, gpus: parsed.gpus, unparsed: parsed.unparsed, elapsedMs: r.elapsedMs };
  }

  async function probeOne(c, nvidia, signal) {
    const r = await run(execFile, c.path, ["-c", PROBE], { env: childEnv(env), cwd: deps.probeDir, signal });
    if (r.aborted) return { aborted: true };
    const base = { ...c, elapsedMs: r.elapsedMs };
    if (!r.ok) return { cand: { ...base, status: "probe-failed", reasons: ["probe-failed"], detail: r.reason }, probed: false };
    const p = parseProbe(r.stdout);
    if (!p.ok) return { cand: { ...base, status: "probe-failed", reasons: ["probe-failed"], detail: p.reason }, probed: false };
    const probe = p.probe;
    const judged = judge(probe, nvidia);
    return {
      probed: true,
      judged,
      cand: {
        ...base,
        status: "probed",
        reasons: judged.reasons,
        versions: {
          python: probe.version || null,
          jupyterServer: probe.jupyterServer || null,
          ipykernel: probe.ipykernel || null,
          torch: probe.torchVersion || null,
          cuda: (probe.torch && probe.torch.cuda) || null,
        },
        conda: !!probe.conda,
        venv: !!probe.venv,
        externallyManaged: !!probe.externallyManaged,
        executable: probe.executable || null,
      },
    };
  }

  async function doDetect(signal) {
    const t0 = Date.now();
    mkdir(deps.probeDir);
    const setting = deps.getSetting ? deps.getSetting() : { mode: "auto" };
    const python = setting && setting.mode === "path" ? { mode: "path", path: setting.path } : { mode: "auto" };
    const canceled = () => ({ state: "canceled", python, selected: null, usable: false, candidates: [], searched: [], nvidia: { found: false, gpus: [] }, capabilities: null, reasons: [], guidance: { missing: [], commands: [], links: [] }, elapsedMs: Date.now() - t0 });

    // 候補を集めるために必要な、起動を伴う確認（py ランチャ・xcode-select）
    let pyList = [];
    let cltInstalled = false;
    if (python.mode !== "path") {
      if (platform === "win32") {
        const P = path.win32;
        const sys = envGet(env, "SystemRoot", platform);
        const local = envGet(env, "LOCALAPPDATA", platform);
        const exes = [
          ...pathDirs(env, platform).map((d) => P.join(d, "py.exe")),
          ...(sys ? [P.join(sys, "py.exe")] : []),
          ...(local ? [P.join(local, "Programs", "Python", "Launcher", "py.exe")] : []),
        ];
        const py = exes.find((p) => isFile(p));
        if (py) {
          const r = await run(execFile, py, ["-0p"], { env: childEnv(env), cwd: deps.probeDir, signal });
          if (r.aborted) return canceled();
          if (r.ok) pyList = parsePyList(r.stdout);
        }
      } else if (platform === "darwin") {
        const r = await run(execFile, "/usr/bin/xcode-select", ["-p"], { env: childEnv(env), cwd: deps.probeDir, signal });
        if (r.aborted) return canceled();
        cltInstalled = r.ok;
      }
    }
    let condaEnvPrefixes = [];
    if (platform === "linux" && python.mode !== "path") {
      const txt = readFile(path.join(homedir, ".conda", "environments.txt"));
      if (txt) condaEnvPrefixes = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    const found = candidates({ platform, env, homedir, exists: isFile, setting, pyList, cltInstalled, condaEnvPrefixes });

    const nvidia = await detectNvidia(signal);
    if (nvidia.aborted) return canceled();

    const cands = [];
    const results = [];
    for (const c of found.candidates) {
      if (c.status === "excluded") {
        cands.push({ ...c, versions: null });
        results.push(null);
        continue;
      }
      const r = await probeOne(c, nvidia, signal);
      if (r.aborted) return canceled();
      cands.push(r.cand);
      results.push(r);
    }

    const pick = rank(results);
    let selected = null;
    let judgedSel = null;
    let usable = false;
    cands.forEach((c, i) => {
      if (c.status === "probed") c.status = "usable";
    });
    if (pick) {
      selected = cands[pick.index];
      judgedSel = results[pick.index].judged;
      usable = pick.tier <= 2;
      selected.status = usable ? "selected" : "missing";
      cands.forEach((c, i) => {
        if (i !== pick.index && c.status === "usable" && !(results[i].judged.hasServer && results[i].judged.hasKernel)) c.status = "missing";
      });
    }
    const reasons = [];
    if (found.candidates.length === 0) reasons.push("no-python");
    else if (!pick) reasons.push(found.candidates.every((c) => c.status === "excluded") ? "no-python" : "probe-failed");
    if (found.candidates.length === 1 && found.candidates[0].reasons.includes("setting-not-found")) reasons.push("setting-not-found");
    return {
      state: found.candidates.length === 0 ? "none" : "ok",
      python,
      selected,
      usable,
      candidates: cands,
      searched: found.searched,
      nvidia: { found: !!nvidia.found, path: nvidia.path || null, gpus: nvidia.gpus || [], error: nvidia.error || null, unparsed: nvidia.unparsed || 0, searched: nvidia.searched || [] },
      capabilities: judgedSel ? judgedSel.capabilities : null,
      reasons: [...new Set([...reasons, ...(judgedSel ? judgedSel.reasons : [])])],
      guidance: pick ? guidance(selected, judgedSel, platform) : { missing: [], commands: [], links: [] },
      elapsedMs: Date.now() - t0,
    };
  }

  /** 同時に 1 本だけ。走っている最中の呼び出しは同じ Promise を返す。結果はアプリが動いている間だけ覚える。 */
  function detect({ force = false } = {}) {
    if (inflight) return inflight;
    if (cache && !force) return Promise.resolve(cache);
    abort = new AbortController();
    const signal = abort.signal;
    inflight = doDetect(signal)
      .then((r) => {
        if (r.state !== "canceled") cache = r;
        return r;
      })
      .catch((e) => ({ state: "error", error: String((e && e.message) || e), python: { mode: "auto" }, selected: null, usable: false, candidates: [], searched: [], nvidia: { found: false, gpus: [] }, capabilities: null, reasons: [], guidance: { missing: [], commands: [], links: [] }, elapsedMs: 0 }))
      .finally(() => {
        inflight = null;
        abort = null;
      });
    return inflight;
  }

  function cancel() {
    if (!abort) return { ok: true, running: false };
    abort.abort();
    return { ok: true, running: true };
  }

  /** 設定を変えたら覚えている結果を捨てる。 */
  function invalidate() {
    cache = null;
  }

  return { detect, cancel, invalidate };
}

let instance = null;

/** main から。`getSetting` は computeEndpoints.get().local.python を返す関数。 */
function init({ dataDir, getSetting }) {
  instance = createDetector({ getSetting, probeDir: path.join(dataDir, "compute-local", "probe") });
}

const need = () => {
  if (!instance) throw new Error("localPython is not initialized");
  return instance;
};

module.exports = {
  PROBE,
  PROBE_MARKER,
  PYTORCH_INSTALL_URL,
  NVIDIA_QUERY,
  candidates,
  parseProbe,
  parseNvidiaSmi,
  parsePyList,
  archSupported,
  judge,
  rank,
  guidance,
  childEnv,
  nvidiaSmiPaths,
  validatePythonPath,
  createDetector,
  init,
  detect: (o) => need().detect(o),
  cancel: () => (instance ? instance.cancel() : { ok: true, running: false }),
  invalidate: () => instance && instance.invalidate(),
};
