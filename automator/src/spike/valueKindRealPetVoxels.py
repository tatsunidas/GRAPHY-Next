"""valueKindRealPetCheck.ts の基準用: 実データの PET（PSMA）の ROI（SEG）の SUVbw の画素値を、DICOM から読み直して .npy に書く。
本体の実装は使わない。SEG の各フレームが参照する PET のインスタンス（ReferencedSOPInstanceUID）に、そのフレームのマスクを当てる。
SUV = 保存値 × RescaleSlope × 係数（係数は引数。本体が記録した値で、SUV の golden テスト（Python の参照）で別に検証済み）。

使い方: python3 -I valueKindRealPetVoxels.py <PSMA の親ディレクトリ> <係数> <出力の .npy>
"""
import glob
import os
import sys

import numpy as np
import pydicom

root, scale, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
seg = pydicom.dcmread(glob.glob(os.path.join(root, "Segmentation*", "*"))[0])
mask = seg.pixel_array  # frames x rows x cols
pet = {}
for f in glob.glob(os.path.join(root, "PET", "*")):
    d = pydicom.dcmread(f)
    pet[str(d.SOPInstanceUID)] = d
vals = []
for i, fg in enumerate(seg.PerFrameFunctionalGroupsSequence):
    sop = str(fg.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID)
    d = pet[sop]
    px = d.pixel_array.astype(np.float64) * float(d.RescaleSlope) + float(d.RescaleIntercept)
    m = mask[i] > 0
    vals.append((px[m] * scale))
v = np.concatenate(vals)
np.save(out, v)
print(len(v), float(v.min()), float(v.max()))
