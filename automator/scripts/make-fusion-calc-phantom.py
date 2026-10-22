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

# 前景 PT は元のファントムの RescaleSlope 0.5 のまま使う。スケール後の最小・最大が整数になる条件で、
# cornerstone の preScale が間の値（694.5 など）を切り捨てていた問題（vite.cornerstonePreScaleFix.ts で修正）の
# 回帰検査を兼ねる。切り捨てが戻ると、乗算の値が numpy の別実装と一致しなくなる。
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
