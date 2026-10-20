"""2 つの派生シリーズ（テクスチャマップ）の値と、取り込んだファイルの転送構文を調べる。

使い方:
  python3 -I compressedCompare.py maps <基準のフォルダ> <比べるフォルダ>
      → {"maxDiff": 値の最大差（Rescale 適用後）, "slices": 枚数, "derivation": 比べる側の DerivationDescription}
  python3 -I compressedCompare.py ts <フォルダ>
      → {"transferSyntaxes": [そのフォルダのファイルの転送構文（重複なし）]}
"""
import glob
import json
import os
import sys

import numpy as np
import pydicom


def values(folder):
    out = {}
    derivation = None
    for f in glob.glob(os.path.join(folder, "*.dcm")):
        d = pydicom.dcmread(f)
        v = d.pixel_array.astype(np.float64) * float(d.RescaleSlope) + float(d.RescaleIntercept)
        out[int(d.InstanceNumber)] = v
        derivation = str(d.get("DerivationDescription", ""))
    return out, derivation


if sys.argv[1] == "maps":
    a, _ = values(sys.argv[2])
    b, derivation = values(sys.argv[3])
    if sorted(a) != sorted(b):
        print(json.dumps({"maxDiff": None, "slices": len(b), "derivation": derivation}))
    else:
        diff = max(float(np.max(np.abs(a[k] - b[k]))) for k in a)
        print(json.dumps({"maxDiff": diff, "slices": len(b), "derivation": derivation}))
else:
    ts = sorted({str(pydicom.dcmread(f, stop_before_pixels=True).file_meta.TransferSyntaxUID)
                 for f in glob.glob(os.path.join(sys.argv[2], "*.dcm"))})
    print(json.dumps({"transferSyntaxes": ts}))
