/// <reference path="../plugin-template/graphy-plugin.d.ts" />
// @ts-check
/*
 * MONAI Bundle を外部の計算機（Google Colab の GPU など）で動かすサンプル（H59 compute.runJob）。
 * 設計: fw/remote-compute-design.md §16。
 *
 * 流れ（「実行」1 回・同意 1 回）:
 *   1. 一覧から Bundle を選ぶ（表示中のシリーズのモダリティに合わないものは選べない）。一覧に無いものは名前を入れる
 *   2. 「実行」→ 本体が匿名化した npz を送る。計算機の上で Bundle の metadata.json
 *      （network_data_format: 入力のモダリティ・チャネル数、出力のラベル名）を読み、使えるかを判定する。
 *      合わなければ推論せずに止まる（モデルの説明と止めた理由は返る）
 *   3. 使えれば monai.bundle の推論を走らせ、ラベルの volume を返す
 *   4. 下見の画像を見せ、選んだラベルを DICOM SEG（H22）で保存する
 *
 * 計算機の上のコード（PY）は、同意画面に全文が出る。Bundle の名前と上書きの設定だけが差し込まれる。
 */

/**
 * 選べる Bundle（2026-10-03 に Hugging Face の MONAI 組織で configs/metadata.json を読んで確かめた）。
 * modality は送る前の絞り込みにだけ使う。使えるかの最終判定は計算機の上で metadata.json から行う。
 * checked: 実機（Colab の T4）で最後まで通したもの。
 */
export const CATALOG = [
  { name: "spleen_ct_segmentation", label: "脾臓", modality: "CT", labels: 1, checked: true },
  { name: "wholeBody_ct_segmentation", label: "全身 104 臓器", modality: "CT", labels: 104 },
  { name: "swin_unetr_btcv_segmentation", label: "腹部 13 臓器（BTCV）", modality: "CT", labels: 13 },
  { name: "multi_organ_segmentation", label: "腹部 7 臓器", modality: "CT", labels: 7 },
  { name: "pancreas_ct_dints_segmentation", label: "膵臓・膵腫瘍", modality: "CT", labels: 2 },
  { name: "renalStructures_UNEST_segmentation", label: "腎臓の構造（造影 CT）", modality: "CT", labels: 3 },
  { name: "prostate_mri_anatomy", label: "前立腺（T2 MR）", modality: "MR", labels: 2 },
  { name: "wholeBrainSeg_Large_UNEST_segmentation", label: "脳 133 領域（T1 MR）", modality: "MR", labels: 132 },
];
const OTHER = "__other__";
/** SEG に渡すマスクの合計（セグメントごとに volume と同じ大きさの配列が要る）。 */
const MAX_SEG_BYTES = 1.5e9;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;

// ---------------------------------------------------------------------------
// 計算機の上で走る Python（下見と推論で共通）。先頭に GRAPHY（mode・bundle・overrides）が足される。
// ---------------------------------------------------------------------------
export const PY = String.raw`
import glob, json, os, re, subprocess, sys, time
from importlib import metadata as _md

B = GRAPHY['bundle']
OVR = GRAPHY.get('overrides') or {}
T0 = time.time()
STAGES = {}


def stage(name, p):
    STAGES[name] = round(time.time() - T0, 1)
    print('__progress__', p, name, flush=True)


def have(dist):
    try:
        _md.version(dist)
        return True
    except _md.PackageNotFoundError:
        return False


def importable(mod):
    import importlib.util
    try:
        return importlib.util.find_spec(mod) is not None
    except ModuleNotFoundError:
        return False


# パッケージを自分で入れるのは Colab（使い捨てのランタイム）のときだけ。
# 利用者が自分で立てた Jupyter の環境は書き換えない（足りなければ名前を示して止める）
COLAB = bool(os.environ.get('COLAB_RELEASE_TAG')) or importable('google.colab')


def pip(*pk):
    if not COLAB:
        raise RuntimeError('missing-packages: この計算機に ' + ' '.join(pk) + ' を入れてください（pip install ' + ' '.join(pk) + '）')
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', '--disable-pip-version-check', *pk])


# Bundle は実行フォルダの外に置く（同じランタイムなら 2 回目はダウンロードしない）
CACHE = '/content/graphy-cache' if COLAB else os.path.join(os.path.expanduser('~'), '.graphy-cache')

stage('setup', 0.02)
# ignite は monai より先に入れる（monai は import の時点で ignite の有無を覚えるので、あとから入れても効かない）。
# Bundle の評価器・ハンドラ（monai.engines / monai.handlers）はほとんどが ignite を使う
missing = [d for d, m in (('pytorch-ignite', 'ignite'), ('monai', 'monai'), ('nibabel', 'nibabel')) if not importable(m)]
if missing:
    pip(*missing)
import numpy as np
import monai
from monai.bundle import ConfigParser
from monai.bundle import download as bundle_download


def fetch():
    name, repo = B['name'], None
    if '/' in name:
        repo, name = name, name.split('/')[-1]
    bdir = os.path.join(CACHE, 'bundles')
    root = os.path.join(bdir, name)
    meta = os.path.join(root, 'configs', 'metadata.json')
    if os.path.isfile(meta):
        return root
    os.makedirs(bdir, exist_ok=True)
    errors = []
    sources = [('huggingface_hub', repo)] if repo else [('monaihosting', None), ('huggingface_hub', 'MONAI/' + name)]
    for src, rp in sources:
        try:
            kw = dict(name=name, bundle_dir=bdir, source=src, progress=False)
            if B.get('version'):
                kw['version'] = B['version']
            if rp:
                kw['repo'] = rp
            bundle_download(**kw)
            if os.path.isfile(meta):
                return root
            errors.append(src + ': no configs/metadata.json')
        except Exception as e:
            errors.append(src + ': ' + str(e)[:300])
    raise RuntimeError('bundle-download-failed: ' + ' | '.join(errors))


def inference_config(root):
    for n in ('inference.json', 'inference.yaml', 'inference.yml'):
        p = os.path.join(root, 'configs', n)
        if os.path.isfile(p):
            return p
    raise RuntimeError('no-inference-config: configs/inference.(json|yaml) がありません')


def head(path, n=3000):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read(n)
    except OSError:
        return None


def gpu():
    try:
        import torch
        if torch.cuda.is_available():
            return {'name': torch.cuda.get_device_name(0),
                    'peakMiB': round(torch.cuda.max_memory_allocated() / 1048576)}
    except Exception:
        pass
    return None


def norm(m):
    u = str(m or '').upper()
    return 'MR' if u == 'MRI' else u


def judge(meta, modality):
    """このシリーズに使えるか。止めるのは明らかに合わないときだけ（プラグインの judge と同じ規則）。"""
    reasons = []
    fmt = meta.get('network_data_format') or {}
    ins, outs = fmt.get('inputs') or {}, fmt.get('outputs') or {}
    if len(ins) > 1:
        reasons.append('入力が %d つ要るモデルです（%s）。1 シリーズでは動かせません' % (len(ins), '・'.join(ins)))
    image = ins.get('image') or (next(iter(ins.values())) if ins else None)
    if image:
        ch = int(image.get('num_channels') or 1)
        if ch != 1:
            reasons.append('入力のチャネル数が %d です（例: 複数の MR 系列を重ねるモデル）。1 シリーズでは動かせません' % ch)
        want = [norm(x) for x in re.split(r'[/,\s]+', str(image.get('modality') or '')) if x]
        have = norm(modality)
        if want and have not in want:
            reasons.append('このモデルは %s 用です（このシリーズは %s）' % ('・'.join(want), have or '不明'))
        # HU の規則はモダリティが書かれていないときだけ（MR なのに hounsfield と書いた Bundle がある）
        if not want and str(image.get('format') or '').lower() == 'hounsfield' and have != 'CT':
            reasons.append('入力は CT の HU 値を前提にしています')
    pred = outs.get('pred') or (next(iter(outs.values())) if outs else None)
    if pred and str(pred.get('format') or '').lower() not in ('segmentation', 'labels', 'label'):
        reasons.append('出力が「%s」です。このサンプルはセグメンテーションだけを扱います' % pred.get('format'))
    return reasons


root = fetch()
meta_path = os.path.join(root, 'configs', 'metadata.json')
meta = json.load(open(meta_path, encoding='utf-8'))
inf_path = inference_config(root)
stage('fetched', 0.25)

# モデルの説明は、合わなくても先に書いて返す（プラグインが画面に出す）
z0 = np.load('inputs/0.npz')
series_meta = json.loads(bytes(z0['meta.json'])) if 'meta.json' in z0.files else {}
reasons = judge(meta, series_meta.get('modality'))
parser = ConfigParser()
parser.read_config(inf_path)
keys = list((parser.get() or {}).keys())
json.dump({
    'name': B['name'],
    'metadata': meta,
    'inferenceConfig': os.path.basename(inf_path),
    'hasDatalist': 'datalist' in keys,
    'license': head(os.path.join(root, 'LICENSE')),
    'dataLicense': head(os.path.join(root, 'docs', 'data_license.txt')),
    'bytes': sum(os.path.getsize(p) for p in glob.glob(os.path.join(root, '**'), recursive=True) if os.path.isfile(p)),
    'monai': monai.__version__,
    'modality': series_meta.get('modality'),
    'reasons': reasons,
}, open('outputs/bundle.json', 'w', encoding='utf-8'), ensure_ascii=False)
if reasons:
    raise RuntimeError('not-applicable: ' + ' / '.join(reasons))   # 推論はしない

# Bundle が求める追加のパッケージ（torch・numpy・monai は Colab のものを使う）
for dist, ver in (meta.get('optional_packages_version') or {}).items():
    if dist.lower() in ('torch', 'torchvision', 'numpy', 'monai', 'pytorch') or have(dist):
        continue
    try:
        pip(dist + '==' + str(ver))
    except Exception:
        pip(dist)
import nibabel as nib
stage('packages', 0.35)

# npz（本体が匿名化して作ったもの）→ NIfTI。volume は [z, y, x]、origin/direction は LPS
z = np.load('inputs/0.npz')
vol, sp, org, dr = z['volume'], z['spacing'], z['origin'], z['direction']
if not (np.all(np.isfinite(sp)) and np.all(np.isfinite(org)) and np.all(np.isfinite(dr))):
    raise RuntimeError('no-geometry: このシリーズには患者座標（間隔・位置・向き）がありません')
nz, ny, nx = vol.shape
lps = np.eye(4)
lps[:3, 0] = dr[0] * sp[2]
lps[:3, 1] = dr[1] * sp[1]
lps[:3, 2] = dr[2] * sp[0]
lps[:3, 3] = org
ras = np.diag([-1.0, -1.0, 1.0, 1.0]) @ lps   # NIfTI は RAS
work = os.path.abspath('work')
os.makedirs(os.path.join(work, 'in'), exist_ok=True)
out_dir = os.path.join(work, 'out')
img = nib.Nifti1Image(np.ascontiguousarray(vol.transpose(2, 1, 0)), ras)
img.set_qform(ras, 1)
img.set_sform(ras, 1)
img.header.set_xyzt_units('mm')
image_path = os.path.join(work, 'in', 'image.nii.gz')
nib.save(img, image_path)
stage('prepared', 0.4)

from monai.bundle import run as bundle_run
kw = dict(config_file=inf_path, meta_file=meta_path, bundle_root=root,
          datalist=[image_path], dataset_dir=os.path.join(work, 'in'), output_dir=out_dir)
logging_conf = os.path.join(root, 'configs', 'logging.conf')
if os.path.isfile(logging_conf):
    kw['logging_file'] = logging_conf
kw.update(OVR)
try:
    import torch
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
except Exception:
    pass
bundle_run(**kw)
stage('inferred', 0.85)

outs = sorted(glob.glob(os.path.join(out_dir, '**', '*.nii*'), recursive=True))
if not outs:
    raise RuntimeError('no-output: output_dir に NIfTI が出ませんでした（datalist / output_dir の上書きに対応していない Bundle かもしれません）')
o = nib.load(outs[0])
lab = np.asanyarray(o.dataobj)
while lab.ndim > 3 and lab.shape[-1] == 1:
    lab = lab[..., 0]
if lab.ndim == 4:
    lab = np.argmax(lab, axis=-1)   # チャネルごとの確率・one-hot
if lab.ndim != 3:
    raise RuntimeError('unexpected-output-shape: ' + str(lab.shape))
lab = np.rint(lab).astype(np.int32)

# 出力の格子 → 入力の格子（同じなら写すだけ。違えば最近傍で取り直す）
m = np.linalg.inv(o.affine) @ ras
resampled = not (lab.shape == (nx, ny, nz) and np.allclose(m, np.eye(4), atol=1e-3))
if resampled:
    # 先に整数へ丸める（端の画素が計算誤差で -1e-12 になり、範囲外として落ちないように）
    res = np.zeros((nx, ny, nz), np.int32)
    ii, jj = np.meshgrid(np.arange(nx), np.arange(ny), indexing='ij')
    for k in range(nz):
        p = m @ np.stack([ii.ravel(), jj.ravel(), np.full(ii.size, k), np.ones(ii.size)])
        q = np.rint(p[:3]).astype(np.int64)
        inside = np.all((q >= 0) & (q < np.array(lab.shape)[:, None]), axis=0)
        v = np.zeros(ii.size, np.int32)
        v[inside] = lab[q[0, inside], q[1, inside], q[2, inside]]
        res[:, :, k] = v.reshape(nx, ny)
    lab = res
zyx = np.ascontiguousarray(lab.transpose(2, 1, 0))
dtype = np.uint8 if zyx.max() < 256 else np.uint16
np.save('outputs/labels.npy', zyx.astype(dtype))
values, counts = np.unique(zyx, return_counts=True)
stage('done', 1.0)
json.dump({
    'name': B['name'],
    'version': meta.get('version'),
    'channelDef': ((meta.get('network_data_format') or {}).get('outputs') or {}).get('pred', {}).get('channel_def'),
    'labels': {str(int(v)): int(c) for v, c in zip(values, counts)},
    'shape': [int(nz), int(ny), int(nx)],
    'geometry': {'spacing': sp.tolist(), 'origin': org.tolist(), 'direction': dr.tolist()},
    'outputFile': os.path.relpath(outs[0], work),
    'resampled': bool(resampled),
    'stages': STAGES,
    'gpu': gpu(),
    'monai': monai.__version__,
}, open('outputs/labels.json', 'w', encoding='utf-8'), ensure_ascii=False)
`;

/**
 * 計算機へ送るコード。設定は JSON 文字列として埋め込む（JSON の文字列リテラルは Python でもそのまま読める）。
 * @param {{ name: string, version?: string | null }} bundle
 * @param {Record<string, unknown>} [overrides] Bundle の設定の上書き（例: wholeBody の highres）
 */
export function buildScript(bundle, overrides = {}) {
  if (!NAME_RE.test(bundle.name)) throw new Error("bad-bundle-name");
  const cfg = JSON.stringify({ bundle: { name: bundle.name, version: bundle.version ?? null }, overrides });
  return `GRAPHY = __import__('json').loads(${JSON.stringify(cfg)})\n` + PY;
}

export function validBundleName(name) {
  return NAME_RE.test(name);
}

/** 本体がデータを作らなかった理由（よく出るものだけ）。 */
const REFUSALS = {
  "npz-duplicate-positions": "同じ位置のスライスが 2 枚以上あります（撮影が 2 回ぶん混ざったシリーズなど）。1 回ぶんだけのシリーズで試してください",
  "npz-uneven-spacing": "スライスの間隔が揃っていません（欠けたスライスがある）",
  "npz-mixed-geometry": "向きや大きさの違う画像が混ざっています",
  "npz-too-large": "シリーズが大きすぎます",
  "permission-denied": "このプラグインに外部の計算機を使う許可がありません",
  "no-endpoint": "環境設定 ＞ 外部の計算機 で計算機を登録してください",
};
export const explain = (code) => (code && REFUSALS[code] ? `${REFUSALS[code]}（${code}）` : String(code));

// ---------------------------------------------------------------------------
// 純関数（node --test で試す）
// ---------------------------------------------------------------------------

/**
 * numpy の .npy（v1/v2・C 順）を読む。対応は u1/u2/i4/f4。
 * @param {Uint8Array} bytes
 */
export function parseNpy(bytes) {
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  if (bytes.length < 10 || magic.some((b, i) => bytes[i] !== b)) throw new Error("npy-magic");
  const major = bytes[6];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const hstart = major === 1 ? 10 : 12;
  const header = new TextDecoder("latin1").decode(bytes.subarray(hstart, hstart + hlen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*True/.test(header);
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (fortran) throw new Error("npy-fortran-order");
  const n = shape.reduce((a, b) => a * b, 1);
  const off = hstart + hlen;
  const body = bytes.slice(off); // 揃った位置から読むために複写する
  /** @type {Record<string, (b: ArrayBuffer) => ArrayLike<number>>} */
  const make = {
    "|u1": (b) => new Uint8Array(b, 0, n),
    "<u1": (b) => new Uint8Array(b, 0, n),
    "<u2": (b) => new Uint16Array(b, 0, n),
    "<i4": (b) => new Int32Array(b, 0, n),
    "<f4": (b) => new Float32Array(b, 0, n),
  };
  if (!descr || !make[descr]) throw new Error("npy-dtype " + descr);
  return { dtype: descr, shape, data: make[descr](body.buffer) };
}

const normModality = (m) => {
  const u = String(m ?? "").toUpperCase();
  return u === "MRI" ? "MR" : u;
};

/**
 * Bundle の network_data_format から、表示中のシリーズに使えるかを判定する。
 * 止めるのは明らかに合わないときだけ（メタデータは作者の自己申告なので、細かい判定はしない）。
 * @param {any} meta metadata.json
 * @param {{ modality: string }} target
 * @returns {{ ok: boolean, reasons: string[], warnings: string[], labels: Array<{ value: number, name: string }> }}
 */
export function judge(meta, target) {
  const reasons = [];
  const warnings = [];
  const fmt = meta && meta.network_data_format;
  const inputs = (fmt && fmt.inputs) || {};
  const outputs = (fmt && fmt.outputs) || {};
  const inKeys = Object.keys(inputs);
  const outKeys = Object.keys(outputs);
  if (!fmt || inKeys.length === 0) warnings.push("入力の形式が書かれていないので、使えるかを判定できません");
  if (inKeys.length > 1) reasons.push(`入力が ${inKeys.length} つ要るモデルです（${inKeys.join("・")}）。1 シリーズでは動かせません`);
  const image = inputs.image ?? inputs[inKeys[0]];
  if (image) {
    const ch = Number(image.num_channels ?? 1);
    if (ch !== 1) reasons.push(`入力のチャネル数が ${ch} です（例: 複数の MR 系列を重ねるモデル）。1 シリーズでは動かせません`);
    const want = String(image.modality ?? "")
      .split(/[\/,\s]+/).map(normModality).filter(Boolean);
    const have = normModality(target.modality);
    if (want.length > 0 && !want.includes(have)) reasons.push(`このモデルは ${want.join("・")} 用です（表示中は ${have || "不明"}）`);
    // HU の規則はモダリティが書かれていないときだけ（MR なのに hounsfield と書いた Bundle がある）
    if (want.length === 0 && String(image.format ?? "").toLowerCase() === "hounsfield" && have !== "CT") {
      reasons.push("入力は CT の HU 値を前提にしています");
    }
  }
  const pred = outputs.pred ?? outputs[outKeys[0]];
  if (pred && !["segmentation", "labels", "label"].includes(String(pred.format ?? "").toLowerCase())) {
    reasons.push(`出力が「${pred.format}」です。このサンプルはセグメンテーションだけを扱います`);
  }
  const labels = [];
  const def = pred && pred.channel_def;
  if (def && typeof def === "object") {
    for (const [k, v] of Object.entries(def)) {
      const value = Number(k);
      if (Number.isInteger(value) && value > 0) labels.push({ value, name: String(v) });
    }
  } else {
    warnings.push("ラベル名（channel_def）が書かれていません。番号で表示します");
  }
  labels.sort((a, b) => a.value - b.value);
  return { ok: reasons.length === 0, reasons, warnings, labels };
}

/**
 * 計算機から返ったラベル（npz と同じ格子 [z, y, x]）のスライスを、loadVolume の格子のスライスへ対応づける。
 * 患者座標で照らし合わせる（並び順の違いに強く、1 枚ずれていれば必ず止まる）。
 * @param {{ spacing: number[], origin: number[], direction: number[][] }} g  labels.json の geometry
 * @param {[number, number, number]} shapeZyx
 * @param {{ dims: [number, number, number], worldToIndex: number[] }} vol
 * @returns {{ ok: true, kMap: Int32Array } | { ok: false, error: string }}
 */
export function mapSlices(g, shapeZyx, vol) {
  const [nz, ny, nx] = shapeZyx;
  const [vx, vy, vz] = vol.dims;
  if (nx !== vx || ny !== vy || nz !== vz) return { ok: false, error: `grid-mismatch: ${nx}x${ny}x${nz} vs ${vx}x${vy}x${vz}` };
  const [dz, dy, dx] = g.spacing;
  const w2i = vol.worldToIndex;
  const toIndex = (p) => [0, 1, 2].map((r) => w2i[r * 4] * p[0] + w2i[r * 4 + 1] * p[1] + w2i[r * 4 + 2] * p[2] + w2i[r * 4 + 3]);
  const world = (i, j, k) => [0, 1, 2].map((a) =>
    g.origin[a] + i * dx * g.direction[0][a] + j * dy * g.direction[1][a] + k * dz * g.direction[2][a]);
  const kMap = new Int32Array(nz);
  const seen = new Uint8Array(nz);
  for (let k = 0; k < nz; k++) {
    const c0 = toIndex(world(0, 0, k));
    const ci = toIndex(world(nx - 1, 0, k));
    const cj = toIndex(world(0, ny - 1, k));
    const kk = Math.round(c0[2]);
    const tol = 0.25;
    const okPlane = Math.abs(c0[0]) < tol && Math.abs(c0[1]) < tol &&
      Math.abs(ci[0] - (nx - 1)) < tol && Math.abs(ci[1]) < tol &&
      Math.abs(cj[0]) < tol && Math.abs(cj[1] - (ny - 1)) < tol;
    if (!okPlane || Math.abs(c0[2] - kk) > tol || kk < 0 || kk >= nz || seen[kk]) {
      return { ok: false, error: `grid-mismatch at slice ${k}` };
    }
    seen[kk] = 1;
    kMap[k] = kk;
  }
  return { ok: true, kMap };
}

/**
 * ラベルの volume から、選んだラベルごとの 0/1 マスク（loadVolume の並び）を作る。
 * @param {ArrayLike<number>} labels [z, y, x]
 * @param {Int32Array} kMap
 * @param {number} nxy  1 スライスの画素数
 * @param {number[]} values
 */
export function splitSegments(labels, kMap, nxy, values) {
  const nz = kMap.length;
  const index = new Map(values.map((v, i) => [v, i]));
  const masks = values.map(() => new Uint8Array(nxy * nz));
  for (let k = 0; k < nz; k++) {
    const src = k * nxy;
    const dst = kMap[k] * nxy;
    for (let p = 0; p < nxy; p++) {
      const i = index.get(labels[src + p]);
      if (i !== undefined) masks[i][dst + p] = 1;
    }
  }
  return masks;
}

/** ラベル番号ごとに見分けやすい色（黄金角で色相を回す）。 */
export function colorFor(value) {
  const h = (value * 137.508) % 360;
  const s = 0.75, l = 0.55;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return /** @type {[number, number, number]} */ ([f(0), f(8), f(4)]);
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

/** @param {any} host */
export async function activate(host) {
  const target = (host.getTargets?.() ?? []).find((t) => t.kind === "image");
  if (!target) {
    host.notify("MONAI: 画像のタイルを選んでから開いてください");
    return;
  }
  const win = host.openWindow({ title: "MONAI Bundle（外部の計算機）", width: 720, height: 760 });
  const root = win.container;
  root.style.cssText = "font: 13px system-ui, sans-serif; padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 8px;";
  /** @type {Record<string, any>} */
  const state = (/** @type {any} */ (window).__monaiState = { phase: "idle" });

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "testid") e.dataset.testid = v;
      else if (k === "style") e.style.cssText = v;
      else e[k] = v;
    }
    for (const c of kids) e.append(c);
    return e;
  };
  const have = normModality(target.modality);
  const picker = el("select", { testid: "monai-bundle", style: "flex: 1" },
    ...CATALOG.map((c) => {
      const o = el("option", {
        value: c.name,
        textContent: `${c.label}（${c.modality}）— ${c.name}${c.checked ? "・確認済み" : ""}`,
      });
      if (c.modality !== have) { o.disabled = true; o.textContent += `（${have || "?"} には使えない）`; }
      return o;
    }),
    el("option", { value: OTHER, textContent: "その他（名前を入れる）" }));
  const firstUsable = CATALOG.find((c) => c.modality === have);
  picker.value = firstUsable ? firstUsable.name : OTHER;
  const nameInput = el("input", { testid: "monai-bundle-name", placeholder: "例: MONAI/spleen_ct_segmentation", style: "flex: 1" });
  const runBtn = el("button", { textContent: "実行", testid: "monai-run" });
  const status = el("div", { testid: "monai-status", style: "color: #52606d; min-height: 1.2em" });
  const info = el("div", { testid: "monai-info" });
  const preview = el("canvas", { testid: "monai-preview", style: "display: none; max-width: 100%; image-rendering: pixelated; border: 1px solid #ccd" });
  const labelBox = el("div", { testid: "monai-labels", style: "display: flex; flex-wrap: wrap; gap: 4px 12px" });
  const saveBtn = el("button", { textContent: "選んだラベルを SEG で保存", testid: "monai-save", disabled: true });
  const result = el("div", { testid: "monai-result" });
  const otherRow = el("div", { style: "display: none; gap: 6px" }, nameInput);
  root.append(
    el("div", {}, `対象: ${target.seriesLabel}（${target.modality}・${target.sliceCount} 枚）`),
    el("div", { style: "display: flex; gap: 6px" }, picker, runBtn),
    otherRow,
    el("div", { style: "font-size: 11px; color: #52606d" },
      "「実行」で、匿名化したこのシリーズを送り、計算機の上でモデルの説明（metadata.json）を読んで使えるかを判定してから推論します。" +
      "合わなければ推論せずに止まります。ライセンスは結果と一緒に出ます。"),
    status, info, preview, labelBox, saveBtn, result,
  );
  const syncPicker = () => { otherRow.style.display = picker.value === OTHER ? "flex" : "none"; };
  picker.addEventListener("change", syncPicker);
  syncPicker();
  const setStatus = (t) => { status.textContent = t; };
  const onProgress = (p, m) => setStatus(`${Math.round(p * 100)}% ${m ?? ""}`);
  // phase は結果を読み終えてから idle に戻す（外から「終わったか」を見る印）
  const busy = (b) => { state.phase = b ? "running" : "idle"; runBtn.disabled = b; picker.disabled = b; saveBtn.disabled = b || !state.labels; };
  win.setCloseGuard?.(() => (state.phase === "running" ? "計算の途中です。閉じると結果を受け取れません。" : null));
  // 閉じたら、この窓で計算に使った Colab のランタイムを解放するかを聞く（確認は本体が出す）。
  // 解放しても次の「実行」が自動で確保し直す
  win.onClose(async () => {
    if (!state.usedCompute || !host.compute.status) return;
    for (const e of await host.compute.status()) {
      if (e.kind === "colab" && e.runtime?.allocated) {
        state.release = await host.compute.releaseRuntime(e.id, { ask: true });
      }
    }
  });

  /** @param {any} b @param {ReturnType<typeof judge>} v */
  function showInfo(b, v) {
    const m = b.metadata ?? {};
    const img = m.network_data_format?.inputs?.image ?? {};
    const rows = [
      ["名前", `${b.name}（版 ${m.version ?? "?"}）`],
      ["説明", m.description ?? ""],
      ["入力", `${img.modality ?? "?"}・${img.format ?? "?"}・チャネル ${img.num_channels ?? "?"}・${JSON.stringify(img.spatial_shape ?? "?")}`],
      ["出力", `${v.labels.length} ラベル: ${v.labels.slice(0, 12).map((l) => l.name).join("、")}${v.labels.length > 12 ? " …" : ""}`],
      ["著者", [].concat(m.authors ?? []).join(", ")],
      ["権利", m.copyright ?? ""],
      ["ライセンス", (b.license ?? "（LICENSE ファイルなし）").split("\n").find((l) => l.trim()) ?? ""],
      ["学習データの条件", (b.dataLicense ?? "").split("\n").find((l) => l.trim()) ?? "（記載なし）"],
      ["大きさ", `${(b.bytes / 1048576).toFixed(0)} MB・MONAI ${b.monai}`],
    ];
    const table = el("table", { style: "border-collapse: collapse; font-size: 12px" },
      ...rows.map(([k, val]) => el("tr", {},
        el("th", { textContent: k, style: "text-align: left; padding: 2px 8px 2px 0; vertical-align: top; color: #334e68; white-space: nowrap" }),
        el("td", { textContent: val, style: "padding: 2px 0" }))));
    info.replaceChildren(table);
    for (const w of v.warnings) info.append(el("div", { textContent: "⚠ " + w, style: "color: #8a4b00" }));
    // 止めた理由は計算機の上の判定（bundle.json の reasons）を正とする
    for (const r of b.reasons ?? v.reasons) info.append(el("div", { textContent: "✕ " + r, style: "color: #b42318" }));
  }

  runBtn.addEventListener("click", async () => {
    const name = picker.value === OTHER ? nameInput.value.trim() : picker.value;
    if (!validBundleName(name)) { setStatus("名前に使えない文字があります"); return; }
    state.bundle = null; state.verdict = null; state.labels = null; state.summary = undefined; state.error = undefined;
    info.replaceChildren(); labelBox.replaceChildren(); result.replaceChildren(); preview.style.display = "none";
    busy(true);
    state.usedCompute = true;
    setStatus("送っています…");
    const r = await host.compute.runJob({
      inputs: [{ studyUid: target.studyUid, seriesUid: target.seriesUid, format: "npz" }],
      script: buildScript({ name }),
      timeoutSec: 3600,
    }, { onProgress });
    if (!r.ok) {
      state.error = r.error;
      setStatus(r.cancelled ? "取り消しました" : `失敗: ${explain(r.error)}`);
      busy(false);
      return;
    }
    // モデルの説明は、合わなかったとき（推論しない）も返る
    const raw = await r.readFile("bundle.json");
    const b = raw ? JSON.parse(new TextDecoder().decode(raw)) : null;
    if (b) {
      state.bundle = b;
      state.verdict = judge(b.metadata, target);
      showInfo(b, state.verdict);
    }
    if (r.status !== "ok") {
      state.error = `${r.errorName}: ${r.errorValue}`;
      state.traceback = r.traceback;
      state.stderr = r.stderr;
      const notApplicable = /^not-applicable/.test(r.errorValue ?? "");
      setStatus(notApplicable ? "このシリーズには使えないモデルです（推論はしていません）" : `失敗: ${r.errorName}: ${r.errorValue}`);
      busy(false);
      return;
    }
    const [lj, ln] = await Promise.all([r.readFile("labels.json"), r.readFile("labels.npy")]);
    if (!lj || !ln) { setStatus("失敗: 結果が返りませんでした"); busy(false); return; }
    const summary = JSON.parse(new TextDecoder().decode(lj));
    const npy = parseNpy(ln);
    setStatus("ボリュームを読み込んでいます…");
    const vol = await host.loadVolume({ studyUid: target.studyUid, seriesUid: target.seriesUid });
    if (!vol) { setStatus("失敗: ボリュームを読めませんでした"); busy(false); return; }
    const mapped = mapSlices(summary.geometry, /** @type {any} */ (npy.shape), vol);
    if (!mapped.ok) { state.error = mapped.error; setStatus(`失敗: ${mapped.error}`); busy(false); return; }
    state.summary = summary;
    state.labels = { data: npy.data, kMap: mapped.kMap, vol };
    showResult(summary);
    setStatus(`できました（${summary.stages?.done ?? "?"} 秒${summary.gpu ? "・" + summary.gpu.name + "・最大 " + summary.gpu.peakMiB + " MiB" : ""}）`);
    busy(false);
  });

  /** @param {any} summary */
  function showResult(summary) {
    const { data, kMap, vol } = state.labels;
    const [nx, ny, nz] = vol.dims;
    const nxy = nx * ny;
    const names = new Map((state.verdict?.labels ?? []).map((l) => [l.value, l.name]));
    const present = Object.entries(summary.labels).map(([v, c]) => ({ value: Number(v), count: c })).filter((x) => x.value > 0);
    // 下見: ラベルがいちばん多いスライス
    let bestK = 0, best = -1;
    for (let k = 0; k < nz; k++) {
      let c = 0;
      for (let p = k * nxy; p < (k + 1) * nxy; p++) if (data[p] > 0) c++;
      if (c > best) { best = c; bestK = k; }
    }
    const kv = kMap[bestK];
    preview.width = nx; preview.height = ny;
    const ctx = /** @type {CanvasRenderingContext2D} */ (preview.getContext("2d"));
    const im = ctx.createImageData(nx, ny);
    const lo = 40 - 200, hi = 40 + 200;
    for (let p = 0; p < nxy; p++) {
      const g = Math.max(0, Math.min(255, ((vol.data[kv * nxy + p] - lo) / (hi - lo)) * 255));
      const v = data[bestK * nxy + p];
      const c = v > 0 ? colorFor(v) : null;
      im.data[p * 4] = c ? (g + c[0]) / 2 : g;
      im.data[p * 4 + 1] = c ? (g + c[1]) / 2 : g;
      im.data[p * 4 + 2] = c ? (g + c[2]) / 2 : g;
      im.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    preview.style.display = "block";
    preview.style.width = Math.min(nx, 512) + "px";
    labelBox.replaceChildren(...present.map((x) => {
      const cb = el("input", { type: "checkbox", checked: present.length <= 8, value: String(x.value) });
      const [r, g, b] = colorFor(x.value);
      return el("label", {},
        cb, el("span", { textContent: "■", style: `color: rgb(${r},${g},${b})` }),
        ` ${names.get(x.value) ?? "label " + x.value}（${x.count}）`);
    }));
    state.present = present;
  }

  saveBtn.addEventListener("click", async () => {
    if (!state.labels) return;
    const values = [...labelBox.querySelectorAll("input:checked")].map((c) => Number(/** @type {HTMLInputElement} */ (c).value));
    if (values.length === 0) { setStatus("保存するラベルを選んでください"); return; }
    const { data, kMap, vol } = state.labels;
    const nvox = vol.dims[0] * vol.dims[1] * vol.dims[2];
    if (nvox * values.length > MAX_SEG_BYTES) {
      setStatus(`選んだラベルが多すぎます（${values.length} 個）。${Math.floor(MAX_SEG_BYTES / nvox)} 個までにしてください`);
      return;
    }
    busy(true);
    const names = new Map((state.verdict?.labels ?? []).map((l) => [l.value, l.name]));
    const masks = splitSegments(data, kMap, vol.dims[0] * vol.dims[1], values);
    const res = await host.saveSegmentation({
      reference: { studyUid: target.studyUid, seriesUid: target.seriesUid },
      grid: { dims: vol.dims, spacing: vol.spacing, ipp: vol.ipp, iop: vol.iop, sliceStep: vol.sliceStep },
      seriesDescription: `MONAI ${state.bundle.name}`,
      segments: values.map((v, i) => ({
        label: names.get(v) ?? `label ${v}`,
        color: colorFor(v),
        description: `${state.bundle.name} ${state.summary.version ?? ""}`.trim(),
        data: masks[i],
      })),
    });
    state.saved = res;
    result.textContent = res.ok ? `保存しました（${res.seriesInstanceUid}）。ROI マネージャの SEG 読み込みで表示できます。`
      : res.cancelled ? "保存を取り消しました" : `保存に失敗しました: ${res.error}`;
    busy(false);
  });
}
