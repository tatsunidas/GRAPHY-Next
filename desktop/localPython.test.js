// `node --test`。設計: fw/remote-compute-design.md「この PC の Python と GPU の検出」
//
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。
// 「実機の記録」は本物の Python で出した出力を testdata/local-python/ に写したもの（ホームは /home/<user> に置換）。
// 記録が取れていない状況（CUDA 可・ドライバが古い・世代が含まれない・MPS・nvidia-smi の実出力）は、
// PyTorch / nvidia-smi の文書の形から作った値で試す。名前に「【実機の記録に差し替え待ち】」と付けてあり、
// これが通っても「実物と同じ」の証拠にはならない。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const lp = require("./localPython");

const rec = (name) => lp.parseProbe(fs.readFileSync(path.join(__dirname, "testdata", "local-python", `probe-${name}.txt`), "utf8"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "graphy-localpy-"));
const NO_SMI = { found: false, gpus: [] };
const smi = (...gpus) => ({ found: true, gpus });
const GPU = { name: "NVIDIA GeForce GTX 1050 Ti", memoryMiB: 4096, driver: "580.95.05", uuid: "GPU-aaaa-bbbb" };

// ── candidates ──────────────────────────────────────────────────────────
const fakeFs = (files) => {
  const set = new Set(files);
  return { exists: (p) => set.has(p) };
};
const paths = (r) => r.candidates.map((c) => c.path);

test("candidates 〈Linux〉: PATH の python3 → conda の base。python3 が見つかれば python は探さない", () => {
  const r = lp.candidates({
    platform: "linux", env: { PATH: "/usr/local/bin:/usr/bin" }, homedir: "/home/u",
    ...fakeFs(["/usr/bin/python3", "/usr/bin/python", "/home/u/anaconda3/bin/python", "/home/u/anaconda3/condabin/conda"]),
  });
  assert.deepEqual(paths(r), ["/usr/bin/python3", "/home/u/anaconda3/bin/python"]);
  assert.deepEqual(r.candidates.map((c) => c.source), ["path", "conda-base"]);
  assert.ok(r.searched.includes("/usr/local/bin/python3"), "探した場所が一覧に入る");
});

test("candidates 〈Linux〉: python3 が無ければ python", () => {
  const r = lp.candidates({ platform: "linux", env: { PATH: "/usr/bin" }, homedir: "/h", ...fakeFs(["/usr/bin/python"]) });
  assert.deepEqual(paths(r), ["/usr/bin/python"]);
});

test("candidates 〈Linux〉: conda の base は condabin/conda がある prefix だけ（負例: -p の環境・envs の下は base ではない）", () => {
  const files = [
    "/home/u/anaconda3/bin/python", "/home/u/anaconda3/condabin/conda",
    "/home/u/proj/.conda/bin/python", // conda create -p の環境: conda-meta はあるが condabin/conda が無い
    "/home/u/anaconda3/envs/stable/bin/python",
  ];
  const r = lp.candidates({
    platform: "linux", env: { PATH: "" }, homedir: "/home/u", ...fakeFs(files),
    condaEnvPrefixes: ["/home/u/anaconda3", "/home/u/proj/.conda", "/home/u/anaconda3/envs/stable"],
  });
  assert.deepEqual(paths(r), ["/home/u/anaconda3/bin/python"]);
});

test("candidates: 同じフォルダ＝同じ環境は 1 つだけ（PATH の anaconda と conda の base が二重にならない）", () => {
  const r = lp.candidates({
    platform: "linux", env: { PATH: "/home/u/anaconda3/bin" }, homedir: "/home/u",
    ...fakeFs(["/home/u/anaconda3/bin/python3", "/home/u/anaconda3/bin/python", "/home/u/anaconda3/condabin/conda"]),
  });
  assert.equal(r.candidates.length, 1);
});

test("candidates: 設定したパスがあれば他を探さない（負例: PATH の python は候補にならず、有無の確認もしない）", () => {
  const asked = [];
  const r = lp.candidates({
    platform: "linux", env: { PATH: "/usr/bin" }, homedir: "/h",
    exists: (p) => { asked.push(p); return p === "/opt/mine/bin/python"; },
    setting: { mode: "path", path: "/opt/mine/bin/python" },
  });
  assert.deepEqual(paths(r), ["/opt/mine/bin/python"]);
  assert.equal(r.candidates[0].source, "setting");
  assert.deepEqual(asked, ["/opt/mine/bin/python"]);
});

test("candidates: 設定したパスが無いファイルなら除外（setting-not-found）", () => {
  const r = lp.candidates({ platform: "linux", env: {}, homedir: "/h", ...fakeFs([]), setting: { mode: "path", path: "/gone/python" } });
  assert.equal(r.candidates[0].status, "excluded");
  assert.deepEqual(r.candidates[0].reasons, ["setting-not-found"]);
});

test("candidates 〈Windows〉: py ランチャの既定が先頭・WindowsApps の代役は『除外』と出る・.exe 以外は除く", () => {
  const stub = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe";
  const r = lp.candidates({
    platform: "win32",
    env: { Path: `${path.win32.dirname(stub)};C:\\Python311` },
    homedir: "C:\\Users\\u",
    ...fakeFs([stub, "C:\\Python311\\python.exe", "C:\\Python312\\python.exe"]),
    pyList: [{ path: "C:\\Python311\\python.exe", isDefault: false }, { path: "C:\\Python312\\python.exe", isDefault: true }],
  });
  assert.equal(r.candidates[0].path, "C:\\Python312\\python.exe");
  assert.equal(r.candidates[0].source, "py-launcher");
  const ex = r.candidates.find((c) => c.path === stub);
  assert.equal(ex.status, "excluded");
  assert.deepEqual(ex.reasons, ["excluded-windowsapps"]);
  assert.ok(r.candidates.filter((c) => c.status === "candidate").every((c) => !/WindowsApps/i.test(c.path)));
  assert.ok(r.searched.includes("py -0p"));
});

test("candidates 〈Windows〉: conda の base は condabin\\conda.bat がある prefix だけ（負例: conda-meta だけのフォルダ）", () => {
  const home = "C:\\Users\\u";
  const r = lp.candidates({
    platform: "win32", env: { Path: "", LOCALAPPDATA: `${home}\\AppData\\Local` }, homedir: home,
    ...fakeFs([`${home}\\anaconda3\\python.exe`, `${home}\\anaconda3\\condabin\\conda.bat`, `${home}\\miniconda3\\python.exe`]),
  });
  assert.deepEqual(paths(r), [`${home}\\anaconda3\\python.exe`]);
});

test("candidates 〈Windows〉: 設定が .exe でない・WindowsApps なら除外", () => {
  for (const [p, reason] of [["C:\\x\\python.bat", "excluded-not-exe"], ["C:\\a\\WindowsApps\\python.exe", "excluded-windowsapps"]]) {
    const r = lp.candidates({ platform: "win32", env: {}, homedir: "C:\\u", ...fakeFs([p]), setting: { mode: "path", path: p } });
    assert.deepEqual(r.candidates[0].reasons, [reason]);
  }
});

test("candidates 〈macOS〉: CLT 無しなら /usr/bin/python3 は除外（起動しない）・有れば候補。Homebrew の場所も探す", () => {
  const files = ["/usr/bin/python3", "/opt/homebrew/bin/python3"];
  const no = lp.candidates({ platform: "darwin", env: { PATH: "/usr/bin:/bin" }, homedir: "/Users/u", ...fakeFs(files), cltInstalled: false });
  const sys = no.candidates.find((c) => c.path === "/usr/bin/python3");
  assert.equal(sys.status, "excluded");
  assert.deepEqual(sys.reasons, ["excluded-no-clt"]);
  assert.equal(no.candidates.filter((c) => c.path === "/usr/bin/python3").length, 1, "二重に載せない");
  assert.equal(no.candidates.find((c) => c.status === "candidate").path, "/opt/homebrew/bin/python3");

  const yes = lp.candidates({ platform: "darwin", env: { PATH: "/usr/bin:/bin" }, homedir: "/Users/u", ...fakeFs(files), cltInstalled: true });
  assert.equal(yes.candidates[0].path, "/usr/bin/python3");
  assert.equal(yes.candidates[0].status, "candidate");
});

test("candidates: 何も無ければ 0 件・探した場所は残る", () => {
  const r = lp.candidates({ platform: "linux", env: { PATH: "/a:/b" }, homedir: "/h", ...fakeFs([]) });
  assert.equal(r.candidates.length, 0);
  assert.ok(r.searched.includes("/a/python3") && r.searched.includes("/b/python"));
});

// ── parse ───────────────────────────────────────────────────────────────
test("parseProbe: 実機の記録を読める（torch 無し・CPU 版 torch）", () => {
  const a = rec("anaconda");
  assert.equal(a.ok, true);
  assert.equal(a.probe.jupyterServer.length > 0, true);
  assert.equal(a.probe.torchVersion, null);
  const c = rec("venv-cpu-torch");
  assert.equal(c.probe.torch.cuda, null);
  assert.equal(c.probe.torch.available, false);
});

test("parseProbe: 前に別の出力があっても最終行の印を読む／印が無い・壊れている・配列は probe-unparsable", () => {
  assert.equal(lp.parseProbe(`noise\n${lp.PROBE_MARKER}{"a":1}\r\n`).probe.a, 1);
  assert.equal(lp.parseProbe(`${lp.PROBE_MARKER}{"a":1}\n${lp.PROBE_MARKER}{"a":2}`).probe.a, 2);
  for (const bad of ["", "hello", `${lp.PROBE_MARKER}{oops`, `${lp.PROBE_MARKER}[1]`, `${lp.PROBE_MARKER}null`]) {
    assert.deepEqual(lp.parseProbe(bad), { ok: false, reason: "probe-unparsable" }, JSON.stringify(bad));
  }
});

test("parseNvidiaSmi 【実機の記録に差し替え待ち: 文書の形から作った CSV】", () => {
  const r = lp.parseNvidiaSmi("NVIDIA GeForce GTX 1050 Ti, 4096, 580.95.05, GPU-1111\nNVIDIA RTX A2000, 12282, 560.94, GPU-2222\n");
  assert.deepEqual(r.gpus, [
    { name: "NVIDIA GeForce GTX 1050 Ti", memoryMiB: 4096, driver: "580.95.05", uuid: "GPU-1111" },
    { name: "NVIDIA RTX A2000", memoryMiB: 12282, driver: "560.94", uuid: "GPU-2222" },
  ]);
  assert.equal(r.unparsed, 0);
});

test("parseNvidiaSmi: 欄が足りない行・容量が数値でない行は捨てずに数える／空は 0 件", () => {
  const r = lp.parseNvidiaSmi("broken line\nGPU Z, [N/A], 1.0, GPU-9\n");
  assert.equal(r.unparsed, 1);
  assert.equal(r.gpus[0].memoryMiB, null, "欠損を 0 で埋めない");
  assert.deepEqual(lp.parseNvidiaSmi(""), { gpus: [], unparsed: 0 });
});

test("parsePyList: py -0p の形（-V:3.12 * path / -3.11-64 path）", () => {
  const r = lp.parsePyList(" -V:3.12 *        C:\\Python312\\python.exe\n -V:3.11          C:\\Python311\\python.exe\nnoise\n");
  assert.deepEqual(r, [{ path: "C:\\Python312\\python.exe", isDefault: true }, { path: "C:\\Python311\\python.exe", isDefault: false }]);
});

// ── 世代 ────────────────────────────────────────────────────────────────
test("archSupported: sm_ は同じ M で m' ≤ m、compute_ は XY ≤ デバイス。文字つきは同じ能力だけ。不明は null", () => {
  assert.equal(lp.archSupported([6, 1], ["sm_60", "sm_70"]), true, "sm_60 の cubin は 6.1 で動く");
  assert.equal(lp.archSupported([6, 1], ["sm_61"]), true);
  assert.equal(lp.archSupported([6, 0], ["sm_61"]), false, "負例: 6.0 は sm_61 を動かせない");
  assert.equal(lp.archSupported([6, 1], ["sm_70", "sm_80", "sm_90"]), false, "負例: M が違う");
  assert.equal(lp.archSupported([6, 1], ["sm_70", "compute_60"]), true, "PTX");
  assert.equal(lp.archSupported([6, 1], ["compute_70"]), false, "負例: PTX は新しいデバイス向けにしか使えない");
  assert.equal(lp.archSupported([9, 0], ["sm_90a"]), true);
  assert.equal(lp.archSupported([9, 1], ["sm_90a"]), false);
  assert.equal(lp.archSupported([12, 0], ["sm_100", "sm_120"]), true);
  assert.equal(lp.archSupported([6, 1], []), null);
  assert.equal(lp.archSupported(null, ["sm_60"]), null);
});

// ── judge ───────────────────────────────────────────────────────────────
test("judge 〈実機の記録: anaconda〉: jupyter_server・ipykernel あり・torch 無し", () => {
  const j = lp.judge(rec("anaconda").probe, NO_SMI);
  assert.deepEqual(j.reasons, ["no-torch"]);
  assert.deepEqual(j.missing, ["torch"]);
  assert.equal(j.hasServer && j.hasKernel, true);
  assert.equal(j.capabilities.accelerator, "cpu");
});

test("judge 〈実機の記録: 空の venv〉: 足りない名前が出る・OS 付属の Python は何も無い", () => {
  const j = lp.judge(rec("venv-empty").probe, NO_SMI);
  assert.deepEqual(j.missing, ["jupyter_server", "ipykernel", "torch"]);
  assert.ok(j.reasons.includes("missing-jupyter-server") && j.reasons.includes("missing-ipykernel"));
  assert.equal(j.hasServer, false);
});

test("judge 〈実機の記録: CPU 版 torch〉+ GPU あり → torch-cpu-build／GPU 無し → 理由なし（理由が変わる負例）", () => {
  const withGpu = lp.judge(rec("venv-cpu-torch").probe, smi(GPU));
  assert.deepEqual(withGpu.reasons, ["torch-cpu-build"]);
  assert.equal(withGpu.cudaUsable, false);
  assert.equal(withGpu.capabilities.accelerator, "cpu");
  assert.equal(withGpu.capabilities.devices[0].name, GPU.name, "見つけた GPU の名前と容量は残る");
  const noGpu = lp.judge(rec("venv-cpu-torch").probe, NO_SMI);
  assert.deepEqual(noGpu.reasons, []);
});

const smiRec = () => lp.parseNvidiaSmi(fs.readFileSync(path.join(__dirname, "testdata", "local-python", "nvidia-smi-gtx1050ti.csv"), "utf8"));

test("judge 〈実機の記録: CUDA 12.6 版 torch＋GTX 1050 Ti〉: sm_61 は archList に無いが sm_60 で動く→CUDA 可。uuid で対応づく", () => {
  const probe = rec("venv-cuda126-gtx1050ti").probe;
  assert.ok(!probe.torch.archList.includes("sm_61"), "実物の archList に sm_61 は無い（これが前提）");
  const g = smiRec();
  assert.equal(g.gpus.length, 1);
  const j = lp.judge(probe, { found: true, gpus: g.gpus });
  assert.deepEqual(j.reasons, []);
  assert.equal(j.cudaUsable, true);
  assert.equal(j.capabilities.accelerator, "cuda");
  assert.equal(j.capabilities.devices[0].name, "NVIDIA GeForce GTX 1050 Ti");
  assert.equal(j.capabilities.devices[0].memoryMiB, 4096, "VRAM の表示値は nvidia-smi");
  assert.equal(j.capabilities.devices[0].memoryBytes, 4227727360, "torch の値は記録に残す");
  assert.equal(j.capabilities.devices[0].archSupported, true);
  assert.equal(j.capabilities.driver, "580.178.04");
});

test("judge 〈実機の記録の負例〉同じ記録から sm_60 を除くと世代が含まれず CUDA 可にならない", () => {
  const probe = rec("venv-cuda126-gtx1050ti").probe;
  const cut = { ...probe, torch: { ...probe.torch, archList: probe.torch.archList.filter((a) => a !== "sm_50" && a !== "sm_60") } };
  const j = lp.judge(cut, { found: true, gpus: smiRec().gpus });
  assert.ok(j.reasons.includes("gpu-arch-unsupported"));
  assert.equal(j.cudaUsable, false);
});

const cudaProbe = (over = {}) => ({
  executable: "/x/python", version: "3.11.9", jupyterServer: "2.14", ipykernel: "6.29", torchVersion: "2.8.0+cu126",
  torch: {
    version: "2.8.0+cu126", cuda: "12.6", available: true, mps: false,
    archList: ["sm_50", "sm_60", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"],
    devices: [{ name: GPU.name, totalMemory: 4228120576, capability: [6, 1], uuid: "aaaa-bbbb" }],
    ...over,
  },
});

test("judge 【実機の記録に差し替え待ち】CUDA 可: 世代がビルドに含まれ、uuid で対応づく。VRAM の表示値は nvidia-smi", () => {
  const j = lp.judge(cudaProbe(), smi(GPU));
  assert.deepEqual(j.reasons, []);
  assert.equal(j.cudaUsable, true);
  assert.equal(j.capabilities.accelerator, "cuda");
  assert.equal(j.capabilities.devices[0].memoryMiB, 4096);
  assert.equal(j.capabilities.devices[0].memoryBytes, 4228120576, "torch の値は記録に残す");
  assert.equal(j.capabilities.devices[0].archSupported, true);
});

test("judge 【実機の記録に差し替え待ち】世代が含まれない: is_available が True でも CUDA 可にならない", () => {
  const p = cudaProbe({ archList: ["sm_70", "sm_75", "sm_80", "sm_86", "sm_90"] });
  const j = lp.judge(p, smi(GPU));
  assert.ok(j.reasons.includes("gpu-arch-unsupported"));
  assert.equal(j.cudaUsable, false);
  assert.equal(j.capabilities.accelerator, "cpu");
  assert.equal(j.capabilities.devices[0].archSupported, false);
});

test("judge 【実機の記録に差し替え待ち】ドライバが古い: version.cuda あり・is_available が False", () => {
  const j = lp.judge(cudaProbe({ available: false, devices: [] }), smi(GPU));
  assert.deepEqual(j.reasons, ["driver-maybe-old"]);
  assert.equal(j.capabilities.driver, GPU.driver);
  assert.equal(j.capabilities.cudaRuntime, "12.6");
});

test("judge 【実機の記録に差し替え待ち】nvidia-smi が無いが torch は CUDA 可: 判定は torch、照合できない旨", () => {
  const j = lp.judge(cudaProbe(), NO_SMI);
  assert.equal(j.cudaUsable, true);
  assert.deepEqual(j.reasons, ["nvidia-smi-missing"]);
});

test("judge 【実機の記録に差し替え待ち】MPS: 表示するが CUDA 可に数えない", () => {
  const p = { executable: "/x", jupyterServer: "2", ipykernel: "6", torchVersion: "2.5", torch: { version: "2.5", cuda: null, available: false, mps: true, archList: [], devices: [] } };
  const j = lp.judge(p, NO_SMI);
  assert.deepEqual(j.reasons, ["mps-available"]);
  assert.equal(j.capabilities.accelerator, "mps");
  assert.equal(j.cudaUsable, false);
});

test("judge: torch の import が失敗 → torch-import-failed（CPU 版と取り違えない）／externally-managed は足りないときだけ", () => {
  const broken = { jupyterServer: "2", ipykernel: "6", torchVersion: "2.5", torch: { error: "ImportError: libcudart" } };
  assert.deepEqual(lp.judge(broken, NO_SMI).reasons, ["torch-import-failed"]);
  const em = { jupyterServer: null, ipykernel: null, torchVersion: null, externallyManaged: true };
  assert.ok(lp.judge(em, NO_SMI).reasons.includes("externally-managed"));
  const ok = { ...broken, torch: { version: "2", cuda: null, available: false, devices: [] }, externallyManaged: true };
  assert.ok(!lp.judge(ok, NO_SMI).reasons.includes("externally-managed"));
});

// ── rank / guidance ────────────────────────────────────────────────────
const J = (probe, nv = NO_SMI) => ({ probed: true, judged: lp.judge(probe, nv) });

test("rank: CUDA 可 > jupyter_server＋ipykernel > 足りない。同じ段は候補の順。PROBE 失敗・除外は選ばない", () => {
  const cpu = J(rec("anaconda").probe);
  const cuda = J(cudaProbe(), smi(GPU));
  const empty = J(rec("venv-empty").probe);
  assert.deepEqual(lp.rank([empty, cpu, cuda]), { index: 2, tier: 1 });
  assert.deepEqual(lp.rank([empty, cpu, J(rec("anaconda").probe)]), { index: 1, tier: 2 });
  assert.deepEqual(lp.rank([null, { probed: false }, empty]), { index: 2, tier: 3 });
  assert.equal(lp.rank([null, { probed: false }]), null);
  assert.equal(lp.rank([]), null);
});

test("rank: MPS は CUDA 可の段に数えない／世代が含まれない GPU も数えない", () => {
  const mps = J({ jupyterServer: "2", ipykernel: "6", torchVersion: "2.5", torch: { cuda: null, available: false, mps: true, archList: [], devices: [] } });
  const unsup = J(cudaProbe({ archList: ["sm_80"] }), smi(GPU));
  const cpu = J(rec("anaconda").probe);
  assert.equal(lp.rank([mps]).tier, 2);
  assert.equal(lp.rank([unsup]).tier, 2);
  assert.equal(lp.rank([unsup, cpu]).index, 0, "同じ段なので順");
});

test("rank: 足りない候補だけのとき、より揃っているものを案内の対象にする", () => {
  const none = J(rec("venv-empty").probe);
  const some = J({ jupyterServer: "2", ipykernel: null, torchVersion: null });
  assert.equal(lp.rank([none, some]).index, 1);
});

test("guidance: 足りない名前＋コピー用のコマンド。PyTorch はコマンドを出さずリンクだけ", () => {
  const j = lp.judge(rec("venv-empty").probe, NO_SMI);
  const g = lp.guidance({ path: "/tmp/venv-empty/bin/python", source: "path" }, j, "linux");
  assert.deepEqual(g.missing, ["jupyter_server", "ipykernel", "torch"]);
  assert.deepEqual(g.commands, [{ shell: "sh", text: "'/tmp/venv-empty/bin/python' -m pip install jupyter_server ipykernel" }]);
  assert.deepEqual(g.links, [lp.PYTORCH_INSTALL_URL]);
  assert.ok(g.commands.every((c) => !/torch/.test(c.text)), "torch の入れ方は出さない");
});

test("guidance 〈Windows〉: PowerShell 形を主に cmd 形も併記（& 付き）／conda の base なら conda install も", () => {
  const j = lp.judge({ jupyterServer: null, ipykernel: "6", torchVersion: "2.5", torch: { cuda: null, available: false, devices: [] } }, NO_SMI);
  const g = lp.guidance({ path: "C:\\Users\\u\\anaconda3\\python.exe", source: "conda-base" }, j, "win32");
  assert.equal(g.commands[0].shell, "powershell");
  assert.equal(g.commands[0].text, '& "C:\\Users\\u\\anaconda3\\python.exe" -m pip install jupyter_server');
  assert.equal(g.commands[1].text, '"C:\\Users\\u\\anaconda3\\python.exe" -m pip install jupyter_server');
  assert.ok(g.commands.some((c) => /^conda install -c conda-forge jupyter_server$/.test(c.text)));
  assert.deepEqual(g.links, [], "torch は入っている");
});

test("guidance: OS 管理の Python（PEP 668）では pip を勧めず、venv を作る案内", () => {
  const j = lp.judge({ jupyterServer: null, ipykernel: null, torchVersion: null, externallyManaged: true }, NO_SMI);
  const g = lp.guidance({ path: "/usr/bin/python3", source: "path" }, j, "linux");
  assert.ok(g.commands[0].text.includes("-m venv"));
  assert.ok(!g.commands.some((c) => /^'\/usr\/bin\/python3' -m pip install/.test(c.text)));
});

test("guidance: パスの ' は sh のクォートで壊れない", () => {
  const j = lp.judge({ jupyterServer: null, ipykernel: "1", torchVersion: "1", torch: { devices: [] } }, NO_SMI);
  const g = lp.guidance({ path: "/home/o'neil/py", source: "path" }, j, "linux");
  assert.equal(g.commands[0].text, "'/home/o'\\''neil/py' -m pip install jupyter_server");
});

// ── 子の環境・パス ──────────────────────────────────────────────────────
test("childEnv: GRAPHY_*・ELECTRON_* を消し、それ以外（PYTHONPATH・CUDA_VISIBLE_DEVICES）は残す", () => {
  const out = lp.childEnv({ GRAPHY_MAIN_SECRET: "s", graphy_x: "1", ELECTRON_RUN_AS_NODE: "1", PATH: "/bin", PYTHONPATH: "/p", CUDA_VISIBLE_DEVICES: "0" });
  assert.deepEqual(out, { PATH: "/bin", PYTHONPATH: "/p", CUDA_VISIBLE_DEVICES: "0" });
});

test("validatePythonPath: 絶対パスだけ・NUL/.. は拒否・Windows は .exe かつ WindowsApps でない", () => {
  assert.deepEqual(lp.validatePythonPath("/usr/bin/python3", { platform: "linux" }), { ok: true });
  assert.equal(lp.validatePythonPath("python3", { platform: "linux" }).reason, "path-not-absolute");
  assert.equal(lp.validatePythonPath("/a/../b", { platform: "linux" }).reason, "path-has-dotdot");
  assert.equal(lp.validatePythonPath("/a\0b", { platform: "linux" }).reason, "path-nul");
  assert.equal(lp.validatePythonPath("", { platform: "linux" }).reason, "path-missing");
  assert.equal(lp.validatePythonPath(42, { platform: "linux" }).reason, "path-missing");
  assert.deepEqual(lp.validatePythonPath("C:\\Py\\python.exe", { platform: "win32" }), { ok: true });
  assert.equal(lp.validatePythonPath("C:\\Py\\python.bat", { platform: "win32" }).reason, "path-not-exe");
  assert.equal(lp.validatePythonPath("C:\\a\\WindowsApps\\python.exe", { platform: "win32" }).reason, "path-windowsapps");
});

test("nvidiaSmiPaths: PATH＋Windows はドライバの置き場所", () => {
  assert.deepEqual(lp.nvidiaSmiPaths({ platform: "linux", env: { PATH: "/usr/bin:/opt/b" } }), ["/usr/bin/nvidia-smi", "/opt/b/nvidia-smi"]);
  const w = lp.nvidiaSmiPaths({ platform: "win32", env: { Path: "C:\\x", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" } });
  assert.deepEqual(w, ["C:\\x\\nvidia-smi.exe", "C:\\Windows\\System32\\nvidia-smi.exe", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe"]);
});

// ── detect（偽の execFile: 起動の形・取り消し・失敗）───────────────────────
function fakeExec(handler) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const done = (err, out = "", errOut = "") => setImmediate(() => cb(err, out, errOut));
    if (opts.signal) {
      const onAbort = () => { const e = new Error("aborted"); e.name = "AbortError"; e.code = "ABORT_ERR"; cb(e, "", ""); };
      if (opts.signal.aborted) { onAbort(); return {}; }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      const r = handler(file, args, opts, done);
      if (r === "hang") return {};
      return {};
    }
    handler(file, args, opts, done);
    return {};
  };
  fn.calls = calls;
  return fn;
}

const probeLine = (rec2) => fs.readFileSync(path.join(__dirname, "testdata", "local-python", `probe-${rec2}.txt`), "utf8");

function detector(execFile, extra = {}) {
  const dir = tmp();
  return lp.createDetector({
    platform: "linux", env: { PATH: "/fake/bin", GRAPHY_MAIN_SECRET: "SECRET", ELECTRON_RUN_AS_NODE: "1", KEEP: "1" }, homedir: "/home/u",
    execFile, probeDir: path.join(dir, "probe"),
    isFile: (p) => ["/fake/bin/python3", "/fake/bin/nvidia-smi"].includes(p),
    readFile: () => null, getSetting: () => ({ mode: "auto" }), ...extra,
  });
}

test("detect: execFile に渡るのは固定の引数・shell:false・専用 cwd・秘密を除いた env だけ", async () => {
  const exec = fakeExec((file, args, opts, done) => {
    if (file.endsWith("nvidia-smi")) return done(null, "GPU A, 2048, 1.0, GPU-1\n");
    done(null, probeLine("anaconda"));
  });
  const d = detector(exec);
  const r = await d.detect({ force: true });
  assert.equal(r.state, "ok");
  assert.equal(exec.calls.length, 2);
  const py = exec.calls.find((c) => c.file === "/fake/bin/python3");
  assert.deepEqual(py.args, ["-c", lp.PROBE]);
  const smiCall = exec.calls.find((c) => c.file === "/fake/bin/nvidia-smi");
  assert.deepEqual(smiCall.args, lp.NVIDIA_QUERY);
  for (const c of exec.calls) {
    assert.equal(c.opts.shell, false);
    assert.equal(c.opts.windowsHide, true);
    assert.ok(c.opts.cwd.endsWith(path.join("probe")), "空の専用フォルダ");
    assert.equal(fs.existsSync(c.opts.cwd) && fs.readdirSync(c.opts.cwd).length, 0, "cwd は空");
    assert.equal(c.opts.env.GRAPHY_MAIN_SECRET, undefined);
    assert.equal(c.opts.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(c.opts.env.KEEP, "1");
  }
  assert.equal(r.nvidia.gpus[0].name, "GPU A");
  assert.equal(r.selected.path, "/fake/bin/python3");
  assert.equal(r.usable, true);
});

test("detect: 非 0 終了・起動失敗・壊れた出力・出力超過は probe-failed（理由つき）で、落ちない", async () => {
  const cases = [
    ["exit", (done) => { const e = new Error("x"); e.code = 3; done(e, "", "boom"); }, "exit:3"],
    ["spawn", (done) => { const e = new Error("x"); e.code = "ENOENT"; done(e); }, "spawn-failed:ENOENT"],
    ["garbage", (done) => done(null, "not json at all"), "probe-unparsable"],
    ["big", (done) => { const e = new Error("x"); e.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"; done(e); }, "probe-output-too-large"],
  ];
  for (const [name, fn, detail] of cases) {
    const d = detector(fakeExec((file, a, o, done) => (file.endsWith("nvidia-smi") ? done(null, "") : fn(done))));
    const r = await d.detect({ force: true });
    assert.equal(r.state, "ok", name);
    assert.equal(r.candidates[0].status, "probe-failed", name);
    assert.equal(r.candidates[0].detail, detail, name);
    assert.equal(r.selected, null, name);
    assert.equal(r.usable, false, name);
    assert.ok(r.reasons.includes("probe-failed"), name);
  }
});

test("detect: 候補が 0 件なら state none・no-python・探した場所つき（Python を起動しない）", async () => {
  const exec = fakeExec(() => assert.fail("起動してはいけない"));
  const d = detector(exec, { isFile: () => false });
  const r = await d.detect({ force: true });
  assert.equal(r.state, "none");
  assert.deepEqual(r.reasons.filter((x) => x === "no-python"), ["no-python"]);
  assert.ok(r.searched.length > 0);
  assert.equal(exec.calls.length, 0);
  assert.equal(r.nvidia.found, false);
});

test("detect: 同時に 1 本だけ（走っている間は同じ Promise）・覚えている結果は force で捨てる", async () => {
  let n = 0;
  const exec = fakeExec((file, a, o, done) => { if (file.endsWith("python3")) n++; done(null, file.endsWith("python3") ? probeLine("system") : ""); });
  const d = detector(exec);
  const [a, b] = [d.detect({ force: true }), d.detect({ force: true })];
  assert.strictEqual(a, b);
  await a;
  assert.equal(n, 1);
  await d.detect();
  assert.equal(n, 1, "覚えている結果を出す");
  await d.detect({ force: true });
  assert.equal(n, 2);
  d.invalidate();
  await d.detect();
  assert.equal(n, 3, "設定を変えたら捨てる");
});

// 起動したまま Jupyter などを後から入れた人が、再起動なしで通る（retryUnusable）。
// 「入れる前」は Jupyter が無い Python（probe-system: 使えない）、「入れた後」は Jupyter の入った Python（probe-venv-cpu-torch: 使える）。
function installable() {
  const st = { installed: false, n: 0, t: 0 };
  const exec = fakeExec((file, a, o, done) => {
    if (file.endsWith("nvidia-smi")) return done(null, "");
    st.n++;
    done(null, probeLine(st.installed ? "venv-cpu-torch" : "system"));
  });
  st.d = detector(exec, { now: () => st.t });
  return st;
}

test("detect retryUnusable: 使えないと覚えたあと、入れ直した環境を再起動なしで使える（force なし）", async () => {
  const st = installable();
  const a = await st.d.detect({ retryUnusable: true });
  assert.equal(a.usable, false, "入れる前は使えない");
  st.installed = true;
  st.t += 5000;
  const b = await st.d.detect({ retryUnusable: true });
  assert.equal(b.usable, true, "入れた後は検出し直して使える");
  assert.ok(b.selected, "使う Python が選ばれる");
});

test("detect retryUnusable: 使えない結果は retryUnusable なしだと従来どおり覚えたまま（回帰）", async () => {
  const st = installable();
  await st.d.detect();
  st.installed = true;
  st.t += 60_000;
  const b = await st.d.detect();
  assert.equal(b.usable, false, "retryUnusable なしなら、覚えている結果");
  assert.equal(st.n, 1);
});

test("detect retryUnusable: 使える結果は検出し直さない（実行のたびに走らせない）", async () => {
  const st = installable();
  st.installed = true;
  await st.d.detect({ retryUnusable: true });
  const n = st.n;
  st.t += 60_000;
  const b = await st.d.detect({ retryUnusable: true });
  assert.equal(b.usable, true);
  assert.equal(st.n, n, "使える結果は覚えたまま");
});

test("detect retryUnusable: 使えない結果でも、覚えて 2 秒以内は検出し直さない・2 秒後は検出し直す", async () => {
  const st = installable();
  await st.d.detect({ retryUnusable: true });
  const n = st.n;
  st.t += 1999;
  await st.d.detect({ retryUnusable: true });
  assert.equal(st.n, n, "2 秒以内は覚えている結果");
  st.t += 1;
  await st.d.detect({ retryUnusable: true });
  assert.ok(st.n > n, "2 秒たてば検出し直す");
});

test("detect: 取り消すと state canceled・覚えない・次の検出は走る", async () => {
  let started;
  const startedP = new Promise((r) => (started = r));
  const exec = fakeExec((file) => {
    if (file.endsWith("python3")) { started(); return "hang"; }
    return undefined;
  });
  // nvidia-smi は即返す（hang しない）。fakeExec のハンドラは done を呼ばないと返らないので別に作る
  const calls = [];
  const exec2 = (file, args, opts, cb) => {
    calls.push(file);
    if (file.endsWith("nvidia-smi")) { setImmediate(() => cb(null, "", "")); return {}; }
    started();
    opts.signal.addEventListener("abort", () => { const e = new Error("a"); e.name = "AbortError"; e.code = "ABORT_ERR"; cb(e); }, { once: true });
    return {};
  };
  void exec;
  const d = detector(exec2);
  const p = d.detect({ force: true });
  await startedP;
  assert.deepEqual(d.cancel(), { ok: true, running: true });
  const r = await p;
  assert.equal(r.state, "canceled");
  assert.deepEqual(d.cancel(), { ok: true, running: false });
  const again = detector((f, a, o, cb) => { setImmediate(() => cb(null, f.endsWith("python3") ? probeLine("system") : "")); return {}; });
  assert.equal((await again.detect()).state, "ok");
});

test("detect: 設定したパスのときは他を探さず、ファイルが無ければ setting-not-found", async () => {
  const exec = fakeExec(() => assert.fail("起動してはいけない"));
  const d = detector(exec, { getSetting: () => ({ mode: "path", path: "/gone/python" }), isFile: () => false });
  const r = await d.detect({ force: true });
  assert.equal(r.python.mode, "path");
  assert.ok(r.reasons.includes("setting-not-found"));
  assert.equal(exec.calls.length, 0);
});

test("detect 〈macOS〉: xcode-select -p が失敗なら /usr/bin/python3 を起動しない", async () => {
  const exec = fakeExec((file, args, opts, done) => {
    if (file === "/usr/bin/xcode-select") { const e = new Error("x"); e.code = 2; return done(e); }
    done(null, "");
  });
  const d = detector(exec, {
    platform: "darwin", env: { PATH: "/usr/bin:/bin" }, homedir: "/Users/u",
    isFile: (p) => p === "/usr/bin/python3",
  });
  const r = await d.detect({ force: true });
  assert.ok(!exec.calls.some((c) => c.file === "/usr/bin/python3"), "起動していない");
  assert.equal(r.candidates[0].status, "excluded");
  assert.deepEqual(r.candidates[0].reasons, ["excluded-no-clt"]);
});

// ── 実際の Python で（コマンド行の通り方を実 OS で見る）──────────────────────
function findRealPython() {
  for (const [cmd, args] of [["python3", ["-c", "print(1)"]], ["python", ["-c", "print(1)"]], ["py", ["-3", "-c", "print(1)"]]]) {
    try {
      if (childProcess.execFileSync(cmd, args, { encoding: "utf8", windowsHide: true }).trim() === "1") return [cmd, args.slice(0, args[0] === "-3" ? 1 : 0)];
    } catch { /* 次 */ }
  }
  return null;
}

test("実際の Python: PROBE が動き、印つきの JSON を返す（Python が無い機では skip と明示）", { skip: findRealPython() ? false : "この機に Python が無い（未達）" }, async () => {
  const [cmd, pre] = findRealPython();
  const dir = tmp();
  const out = childProcess.execFileSync(cmd, [...pre, "-c", lp.PROBE], { cwd: dir, encoding: "utf8", windowsHide: true, shell: false });
  const p = lp.parseProbe(out);
  assert.equal(p.ok, true, out);
  assert.match(p.probe.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof p.probe.executable, "string");
  assert.ok("jupyterServer" in p.probe && "ipykernel" in p.probe && "torchVersion" in p.probe);
});
