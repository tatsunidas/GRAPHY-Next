"""
geomRadiomicsCheck.ts の負例用: 1 シリーズを複製し、PixelSpacing の行/列を入れ替え、UID を作り直す。

    python3 -I geomMakeSwapped.py <元シリーズのフォルダ> <出力フォルダ> <uid-seed>

標準出力に {"seriesUid": 新, "sops": [元の順の新 SOP]} を JSON で書く。
（アプリが行/列の間隔を取り違えた場合と同じ状況を作り、検査器が落ちることを確かめる。）
"""
import glob
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.uid import UID

src, dst, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
rng = np.random.default_rng(seed)
new = lambda: UID("2.25." + str(int.from_bytes(rng.bytes(16), "big")))
os.makedirs(dst, exist_ok=True)
series = new()
sops = []
for f in sorted(glob.glob(os.path.join(src, "*.dcm"))):
    ds = pydicom.dcmread(f)
    r, c = ds.PixelSpacing
    ds.PixelSpacing = [c, r]
    ds.SeriesInstanceUID = series
    sop = new()
    ds.SOPInstanceUID = sop
    ds.file_meta.MediaStorageSOPInstanceUID = sop
    ds.SeriesDescription = "GEOMV swapped-spacing negative"
    ds.save_as(os.path.join(dst, os.path.basename(f)))
    sops.append(str(sop))
print(json.dumps({"seriesUid": str(series), "sops": sops}))
