"""
Fusion の演算結果の保存（差分・乗算）の実機検証に使う合成 DICOM。

    python make-fusion-calc-phantom.py <出力フォルダ>

make-fusion-isoline-phantom.py の出力（背景 CT = 一様 40 HU、前景 PT = ガウス球）に、
同じ幾何・同じ FrameOfReference の **2 本目の CT（一様 100 HU、SeriesDescription "CT100 second"）**を足す。
CT どうし（単位 HU が同じ）の差分が、元のモダリティのまま保存される経路の検証に使う。
真値: 100 − 40 = 60 HU（符号付き差分の符号は、前景と背景を入れ替えると −60 になることで確かめる）。
"""
import glob
import os
import subprocess
import sys

import numpy as np
import pydicom
from pydicom.uid import generate_uid

out = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
subprocess.run([sys.executable, os.path.join(here, "make-fusion-isoline-phantom.py"), out], check=True, stdout=subprocess.DEVNULL)

# 前景 PT の RescaleSlope を 0.37 に作り直す。
# 元のファントムは slope 0.5 で、スケール後の最小値・最大値がどちらも整数になる。cornerstone の dicom-image-loader は
# 「最小値と最大値が整数」だけを見て整数型の配列（Uint16）を選ぶため、間の値（694.5 など）が切り捨てられる
# （読み込み側の既存の挙動。本機能の検証から切り離すため、ここでは踏まない条件にする）。
import json
SLOPE = 0.37
truth_path = os.path.join(out, "truth.json")
truth = json.load(open(truth_path))
A, B, SIGMA = truth["A"], truth["B"], truth["sigma"]
fgt = truth["fg"]
xs = fgt["origin_xy"] + fgt["spacing"] * np.arange(fgt["cols"])
X, Y = np.meshgrid(xs, xs)
for k, path in enumerate(sorted(glob.glob(os.path.join(out, "pt_*.dcm")))):
    ds = pydicom.dcmread(path)
    f = A * np.exp(-(X ** 2 + Y ** 2 + fgt["z"][k] ** 2) / (2 * SIGMA ** 2)) + B
    ds.RescaleSlope = SLOPE
    ds.PixelData = np.rint(f / SLOPE).astype(np.uint16).tobytes()
    ds.save_as(path, write_like_original=False)
fgt["slope"] = SLOPE
json.dump(truth, open(truth_path, "w"), indent=2)

series = generate_uid()
for path in sorted(glob.glob(os.path.join(out, "ct_*.dcm"))):
    ds = pydicom.dcmread(path)
    ds.SeriesInstanceUID = series
    ds.SeriesNumber = 3
    ds.SeriesDescription = "CT100 second"
    sop = generate_uid()
    ds.SOPInstanceUID = sop
    ds.file_meta.MediaStorageSOPInstanceUID = sop
    ds.PixelData = np.full((ds.Rows, ds.Columns), 1124, np.uint16).tobytes()  # 1124 - 1024 = 100 HU
    ds.save_as(os.path.join(out, os.path.basename(path).replace("ct_", "ct2_")), write_like_original=False)
print("ok")
