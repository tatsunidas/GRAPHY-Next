"""MSD Task01（脳腫瘍）の 1 症例を、brats_mri_segmentation Bundle の入力形式へ並べ替える。

MSD の 4D 画像のチャネルは FLAIR, T1w, t1gd, T2w。Bundle（metadata の channel_def）は T1c, T1, T2, FLAIR。
基準ラベルは MSD の 1=浮腫, 2=非造影腫瘍, 3=造影腫瘍 → Bundle の出力値 2（浮腫）, 1（コア。非造影）, 4（造影）へ振り直す。

使い方: python -I monai_brats_prep.py --image <4D.nii.gz> --label <label.nii.gz> --out-dir <dir> --case <id>
出力: <dir>/<case>_{T1c,T1,T2,FLAIR}.nii.gz と <dir>/<case>_label.nii.gz（Bundle の値）
"""
import argparse
import os

import nibabel as nib
import numpy as np

# Bundle のチャネル順 → MSD 4D のチャネル添字
ORDER = {"T1c": 2, "T1": 1, "T2": 3, "FLAIR": 0}
# MSD のラベル値 → Bundle の出力値
RELABEL = {1: 2, 2: 1, 3: 4}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--case", required=True)
    a = ap.parse_args()
    img = nib.load(a.image)
    if img.ndim != 4 or img.shape[3] != 4:
        raise SystemExit("4D（4 チャネル）の画像ではありません: %s" % (img.shape,))
    data = np.asanyarray(img.dataobj)
    os.makedirs(a.out_dir, exist_ok=True)
    for name, ch in ORDER.items():
        out = nib.Nifti1Image(np.ascontiguousarray(data[..., ch]), img.affine)
        nib.save(out, os.path.join(a.out_dir, "%s_%s.nii.gz" % (a.case, name)))
    lab = nib.load(a.label)
    ld = np.asanyarray(lab.dataobj).astype(np.int16)
    unknown = set(np.unique(ld).tolist()) - {0, 1, 2, 3}
    if unknown:
        raise SystemExit("想定外のラベル値: %s" % sorted(unknown))
    new = np.zeros_like(ld)
    for k, v in RELABEL.items():
        new[ld == k] = v
    nib.save(nib.Nifti1Image(new, lab.affine), os.path.join(a.out_dir, "%s_label.nii.gz" % a.case))


if __name__ == "__main__":
    main()
