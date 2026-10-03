// node --test examples/remote-compute-monai
//
// 計算機の上のコード（PY）も試すときは、numpy・scipy・nibabel のある Python を渡す:
//   GRAPHY_TEST_PYTHON=C:\Users\...\python.exe [GRAPHY_TEST_PYTHONPATH=<nibabel の場所>] node --test examples/remote-compute-monai
// MONAI は偽物（入力の閾値で 2 ラベルを作る）に差し替えるので、確かめるのは「npz → NIfTI → 結果 → npz の格子」の往復。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CATALOG, buildScript, colorFor, judge, labelTable, mapSlices, parseNpy, reorderLabels, validBundleName } from "./ui.js";

function npy(descr, shape, bytes) {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const total = 10 + header.length + 1;
  header += " ".repeat((64 - (total % 64)) % 64) + "\n";
  const out = new Uint8Array(10 + header.length + bytes.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  new DataView(out.buffer).setUint16(8, header.length, true);
  out.set(new TextEncoder().encode(header), 10);
  out.set(bytes, 10 + header.length);
  return out;
}

test("parseNpy reads uint8 and uint16", () => {
  const a = parseNpy(npy("|u1", [2, 3], new Uint8Array([1, 2, 3, 4, 5, 6])));
  assert.deepEqual(a.shape, [2, 3]);
  assert.deepEqual([...a.data], [1, 2, 3, 4, 5, 6]);
  const b = parseNpy(npy("<u2", [2], new Uint8Array(new Uint16Array([300, 7]).buffer)));
  assert.deepEqual([...b.data], [300, 7]);
  assert.throws(() => parseNpy(new Uint8Array(20)), /npy-magic/);
});

const spleenMeta = {
  version: "0.5.3",
  network_data_format: {
    inputs: { image: { type: "image", format: "hounsfield", modality: "CT", num_channels: 1, spatial_shape: [96, 96, 96] } },
    outputs: { pred: { type: "image", format: "segmentation", num_channels: 2, channel_def: { 0: "background", 1: "spleen" } } },
  },
};

test("judge accepts a CT segmentation bundle for CT and lists the labels", () => {
  const v = judge(spleenMeta, { modality: "CT" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.labels, [{ value: 1, name: "spleen" }]);
});

test("judge refuses obvious mismatches", () => {
  assert.equal(judge(spleenMeta, { modality: "MR" }).ok, false);
  const brats = {
    network_data_format: {
      inputs: { image: { format: "magnitude", modality: "MRI", num_channels: 4 } },
      outputs: { pred: { format: "segmentation", channel_def: { 0: "TC", 1: "WT", 2: "ET" } } },
    },
  };
  const v = judge(brats, { modality: "MR" });
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(), /チャネル数が 4/);
  const cls = { network_data_format: { inputs: { image: { modality: "CT", num_channels: 1 } }, outputs: { pred: { format: "classification" } } } };
  assert.equal(judge(cls, { modality: "CT" }).ok, false);
});

test("judge tolerates how real bundles describe themselves", () => {
  // prostate_mri_anatomy は出力の形式を "labels" と書く
  const prostate = {
    network_data_format: {
      inputs: { image: { format: "magnitude", modality: "MR", num_channels: 1 } },
      outputs: { pred: { format: "labels", channel_def: { 0: "background", 1: "TZ", 2: "PZ" } } },
    },
  };
  assert.equal(judge(prostate, { modality: "MR" }).ok, true);
  // wholeBrainSeg_Large_UNEST_segmentation は MRI なのに format を "hounsfield" と書く
  const brain = {
    network_data_format: {
      inputs: { image: { format: "hounsfield", modality: "MRI", num_channels: 1 } },
      outputs: { pred: { format: "segmentation", channel_def: { 0: "background", 1: "a" } } },
    },
  };
  assert.equal(judge(brain, { modality: "MR" }).ok, true);
  assert.equal(judge(brain, { modality: "CT" }).ok, false);
});

test("the catalog only lists single-series segmentation bundles with valid names", () => {
  assert.ok(CATALOG.length >= 5);
  for (const c of CATALOG) {
    assert.equal(validBundleName(c.name), true, c.name);
    assert.ok(c.modality === "CT" || c.modality === "MR", c.name);
  }
  assert.equal(new Set(CATALOG.map((c) => c.name)).size, CATALOG.length);
});

test("judge without network_data_format warns but does not block", () => {
  const v = judge({}, { modality: "CT" });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.length >= 1);
});

/** npz の幾何（[dz, dy, dx]・LPS）から loadVolume 風の格子を作る。reversed なら k が逆向き。 */
function volGrid(g, nx, ny, nz, reversed) {
  const [dz, dy, dx] = g.spacing;
  const [r0, r1, r2] = g.direction;
  const o = reversed ? g.origin.map((v, a) => v + (nz - 1) * dz * r2[a]) : g.origin;
  const s = reversed ? -dz : dz;
  // index → world（行 4 要素ずつ）
  const m = [
    [r0[0] * dx, r1[0] * dy, r2[0] * s, o[0]],
    [r0[1] * dx, r1[1] * dy, r2[1] * s, o[1]],
    [r0[2] * dx, r1[2] * dy, r2[2] * s, o[2]],
  ];
  // 逆行列（3x3 部分の逆 + 平行移動）
  const a = m.map((r) => r.slice(0, 3));
  const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const inv = [
    [(a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det],
    [(a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det],
    [(a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det],
  ];
  const w2i = [];
  for (let r = 0; r < 3; r++) w2i.push(...inv[r], -(inv[r][0] * o[0] + inv[r][1] * o[1] + inv[r][2] * o[2]));
  w2i.push(0, 0, 0, 1);
  return { dims: [nx, ny, nz], worldToIndex: w2i };
}

const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
const geom = { spacing: [2.5, 0.8, 0.7], origin: [-100, -120, 50], direction: [[c, s, 0], [-s, c, 0], [0, 0, 1]] };

test("mapSlices follows the slice order of the host volume", () => {
  const same = mapSlices(geom, [4, 3, 5], volGrid(geom, 5, 3, 4, false));
  assert.equal(same.ok, true);
  assert.deepEqual([...same.kMap], [0, 1, 2, 3]);
  const rev = mapSlices(geom, [4, 3, 5], volGrid(geom, 5, 3, 4, true));
  assert.equal(rev.ok, true);
  assert.deepEqual([...rev.kMap], [3, 2, 1, 0]);
});

test("mapSlices refuses a grid that is off by one slice or a different size", () => {
  const shifted = { ...geom, origin: geom.origin.map((v, a) => v + 2.5 * geom.direction[2][a]) };
  assert.equal(mapSlices(shifted, [4, 3, 5], volGrid(geom, 5, 3, 4, false)).ok, false);
  assert.equal(mapSlices(geom, [4, 3, 6], volGrid(geom, 5, 3, 4, false)).ok, false);
  const flippedX = { ...geom, direction: [geom.direction[0].map((v) => -v), geom.direction[1], geom.direction[2]] };
  assert.equal(mapSlices(flippedX, [4, 3, 5], volGrid(geom, 5, 3, 4, false)).ok, false);
});

test("reorderLabels writes each npz slice into the mapped host slice, keeping the type", () => {
  // 2 スライス × 2 画素。スライスは逆順に対応
  const out = reorderLabels(new Uint16Array([1, 0, 300, 1]), new Int32Array([1, 0]), 2);
  assert.ok(out instanceof Uint16Array);
  assert.deepEqual([...out], [300, 1, 1, 0]);
});

test("labelTable names labels from channel_def and falls back to the number", () => {
  const t = labelTable([1, 5], new Map([[1, "spleen"]]), "d");
  assert.deepEqual(t.map((x) => [x.value, x.label, x.description]), [[1, "spleen", "d"], [5, "label 5", "d"]]);
  assert.equal(t[0].color.length, 3);
});

test("colorFor gives distinct colors for neighbours", () => {
  assert.notDeepEqual(colorFor(1), colorFor(2));
  for (const v of colorFor(7)) assert.ok(v >= 0 && v <= 255);
});

test("buildScript embeds only the bundle settings and passes the code inspector limits", () => {
  assert.throws(() => buildScript({ name: "x'; import os" }), /bad-bundle-name/);
  assert.equal(validBundleName("MONAI/spleen_ct_segmentation"), true);
  assert.equal(validBundleName("../etc"), false);
  assert.equal(validBundleName(".."), false);
  const code = buildScript({ name: "spleen_ct_segmentation" }, { highres: false });
  assert.ok(code.length < 64 * 1024);
  // CodeInspector: base64 風の 200 文字以上・数字の 400 文字以上の連なりがあると「埋め込みデータ」とみなされる
  assert.equal(/[A-Za-z0-9+/=_-]{200,}/.test(code), false);
  assert.equal(/[0-9.,\s-]{400,}/.test(code), false);
  assert.match(code.split("\n")[0], /^GRAPHY = __import__\('json'\)\.loads\(".*spleen_ct_segmentation.*"\)$/);
});

// ---------------------------------------------------------------------------
// PY の往復（偽の MONAI で）
// ---------------------------------------------------------------------------
const PYTHON = process.env.GRAPHY_TEST_PYTHON;

const FAKE_MONAI = {
  "monai/__init__.py": "__version__ = '0.0-fake'\n",
  "ignite/__init__.py": "",
  "monai/bundle/__init__.py": `
import json, os, shutil
import numpy as np


class ConfigParser:
    def read_config(self, p):
        self.c = json.load(open(p))

    def get(self):
        return self.c


def download(name, bundle_dir, source, progress=True, version=None, repo=None):
    shutil.copytree(os.environ['FAKE_BUNDLE_SRC'], os.path.join(bundle_dir, name))


def run(config_file, meta_file, bundle_root, datalist, dataset_dir, output_dir, logging_file=None, **kw):
    import nibabel as nib
    img = nib.load(datalist[0])
    a = np.asanyarray(img.dataobj)
    lab = (a > 500).astype(np.uint8) + (a > 1500).astype(np.uint8)
    aff = img.affine
    mode = os.environ.get('FAKE_MODE', 'same')
    if mode == 'flip':      # 保存の向きだけ x を反転（同じ場所を指す）
        lab = lab[::-1]
        f = np.eye(4); f[0, 0] = -1; f[0, 3] = a.shape[0] - 1
        aff = aff @ f
    elif mode == 'onehot':  # チャネルごとの one-hot
        lab = np.stack([lab == 0, lab == 1, lab == 2], -1).astype(np.float32)
    os.makedirs(os.path.join(output_dir, 'image'), exist_ok=True)
    nib.save(nib.Nifti1Image(lab, aff), os.path.join(output_dir, 'image', 'image_seg.nii.gz'))
`,
};

const MAKE_INPUT = `
import json, os, numpy as np
c, s = np.cos(np.pi / 6), np.sin(np.pi / 6)
vol = np.zeros((6, 7, 9), np.float32)   # [z, y, x]
vol[1, 2, 3] = 1000                     # 非対称な目印
vol[4, 5, 7] = 2000
vol[2, 0, 8] = 700
os.makedirs('inputs', exist_ok=True); os.makedirs('outputs', exist_ok=True)
np.savez('inputs/0.npz', volume=vol, spacing=np.array([2.5, 0.8, 0.7]), origin=np.array([-100.0, -120.0, 50.0]),
         direction=np.array([[c, s, 0], [-s, c, 0], [0, 0, 1.0]]))
np.save('expected.npy', ((vol > 500).astype(np.uint8) + (vol > 1500).astype(np.uint8)))
import zipfile
with zipfile.ZipFile('inputs/0.npz', 'a') as zf:
    zf.writestr('meta.json', json.dumps({'format': 'graphy-npz/1', 'modality': os.environ.get('FAKE_MODALITY', 'CT')}))
`;

for (const mode of ["same", "flip", "onehot"]) {
  test(`PY round trip keeps the voxel grid (${mode})`, { skip: !PYTHON && "GRAPHY_TEST_PYTHON is not set" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-monai-"));
    try {
      const lib = path.join(dir, "lib");
      for (const [p, body] of Object.entries(FAKE_MONAI)) {
        fs.mkdirSync(path.dirname(path.join(lib, p)), { recursive: true });
        fs.writeFileSync(path.join(lib, p), body);
      }
      const bundle = path.join(dir, "bundle");
      fs.mkdirSync(path.join(bundle, "configs"), { recursive: true });
      fs.writeFileSync(path.join(bundle, "configs", "metadata.json"), JSON.stringify(spleenMeta));
      fs.writeFileSync(path.join(bundle, "configs", "inference.json"), JSON.stringify({ datalist: [], output_dir: "x" }));
      const run = path.join(dir, "run");
      fs.mkdirSync(run);
      const env = {
        ...process.env,
        PYTHONPATH: [lib, process.env.GRAPHY_TEST_PYTHONPATH].filter(Boolean).join(path.delimiter),
        FAKE_BUNDLE_SRC: bundle,
        FAKE_MODE: mode,
        HOME: dir,
        USERPROFILE: dir,
        PIP_NO_INDEX: "1", PYTHONIOENCODING: "utf-8", // 万一 pip が呼ばれても手元の環境を書き換えない
      };
      delete env.COLAB_RELEASE_TAG;
      const py = (code) => {
        const r = spawnSync(PYTHON, ["-c", code], { cwd: run, env, encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout;
      };
      py(MAKE_INPUT);
      const out = py(buildScript({ name: "fake_bundle" }));
      assert.match(out, /__progress__ 1\.0 done/);
      // NIfTI の向き: voxel (i,j,k) の RAS は npz の LPS の x・y を反転したもの
      py(`
import numpy as np, nibabel as nib
z = np.load('inputs/0.npz'); a = nib.load('work/in/image.nii.gz').affine
sp, o, d = z['spacing'], z['origin'], z['direction']
for i, j, k in [(0, 0, 0), (3, 2, 1), (8, 6, 5)]:
    lps = o + i * sp[2] * d[0] + j * sp[1] * d[1] + k * sp[0] * d[2]
    ras = a @ [i, j, k, 1]
    assert np.allclose(ras[:3], [-lps[0], -lps[1], lps[2]]), (i, j, k, ras, lps)
v = nib.load('work/in/image.nii.gz').get_fdata()
assert v[3, 2, 1] == 1000 and v[7, 5, 4] == 2000
`);
      const labels = parseNpy(new Uint8Array(fs.readFileSync(path.join(run, "outputs", "labels.npy"))));
      const expected = parseNpy(new Uint8Array(fs.readFileSync(path.join(run, "expected.npy"))));
      assert.deepEqual(labels.shape, [6, 7, 9]);
      assert.deepEqual([...labels.data], [...expected.data]);
      const summary = JSON.parse(fs.readFileSync(path.join(run, "outputs", "labels.json"), "utf8"));
      assert.equal(summary.resampled, mode === "flip");
      assert.deepEqual(summary.labels, { 0: 6 * 7 * 9 - 3, 1: 2, 2: 1 });
      assert.deepEqual(summary.channelDef, { 0: "background", 1: "spleen" });
      // 本体の格子（スライスが逆順）へ写しても目印が同じ場所に来る
      const mapped = mapSlices(summary.geometry, labels.shape, volGrid(summary.geometry, 9, 7, 6, true));
      assert.equal(mapped.ok, true);
      const host = reorderLabels(labels.data, mapped.kMap, 63);
      assert.equal(host[(5 - 1) * 63 + 2 * 9 + 3], 1);
      assert.equal(host[(5 - 4) * 63 + 5 * 9 + 7], 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("PY does not install packages outside Colab", { skip: !PYTHON && "GRAPHY_TEST_PYTHON is not set" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-monai-"));
  try {
    const env = { ...process.env, PIP_NO_INDEX: "1", PYTHONIOENCODING: "utf-8", HOME: dir, USERPROFILE: dir, PYTHONPATH: path.join(dir, "empty") };
    delete env.COLAB_RELEASE_TAG;
    const r = spawnSync(PYTHON, ["-c", buildScript({ name: "spleen_ct_segmentation" })], { cwd: dir, env, encoding: "utf8" });
    // 手元の Python に MONAI が入っていれば先へ進むので、そのときは「pip を呼んでいない」ことだけ確かめる
    assert.doesNotMatch(r.stdout + r.stderr, /Collecting|Successfully installed/);
    if (r.status !== 0 && /monai|nibabel/.test(r.stderr)) assert.match(r.stderr, /missing-packages/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PY stops before inference when the series does not fit, but still returns the model description", { skip: !PYTHON && "GRAPHY_TEST_PYTHON is not set" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-monai-"));
  try {
    const lib = path.join(dir, "lib");
    for (const [p, body] of Object.entries(FAKE_MONAI)) {
      fs.mkdirSync(path.dirname(path.join(lib, p)), { recursive: true });
      fs.writeFileSync(path.join(lib, p), body);
    }
    const bundle = path.join(dir, "bundle");
    fs.mkdirSync(path.join(bundle, "configs"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "configs", "metadata.json"), JSON.stringify(spleenMeta));
    fs.writeFileSync(path.join(bundle, "configs", "inference.json"), JSON.stringify({ datalist: [], output_dir: "x" }));
    fs.writeFileSync(path.join(bundle, "LICENSE"), "Apache License\n");
    const run = path.join(dir, "run");
    fs.mkdirSync(run);
    const env = {
      ...process.env,
      PYTHONPATH: [lib, process.env.GRAPHY_TEST_PYTHONPATH].filter(Boolean).join(path.delimiter),
      FAKE_BUNDLE_SRC: bundle,
      FAKE_MODALITY: "MR",
      HOME: dir,
      USERPROFILE: dir,
      PIP_NO_INDEX: "1", PYTHONIOENCODING: "utf-8",
    };
    delete env.COLAB_RELEASE_TAG;
    const py = (code) => spawnSync(PYTHON, ["-c", code], { cwd: run, env, encoding: "utf8" });
    assert.equal(py(MAKE_INPUT).status, 0);
    const r = py(buildScript({ name: "fake_bundle" }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not-applicable: このモデルは CT 用です（このシリーズは MR）/);
    const b = JSON.parse(fs.readFileSync(path.join(run, "outputs", "bundle.json"), "utf8"));
    assert.equal(b.modality, "MR");
    assert.equal(b.license.trim(), "Apache License");
    assert.deepEqual(b.reasons, ["このモデルは CT 用です（このシリーズは MR）"]);
    assert.equal(fs.existsSync(path.join(run, "outputs", "labels.npy")), false, "推論していない");
    assert.equal(fs.existsSync(path.join(run, "work")), false, "画像を NIfTI にもしていない");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
