"""specBundleCheck.ts 用の合成 CT 2 シリーズ（roiFeatureSynth.py を使う）。
  spaced     画素間隔（PixelSpacing）あり
  nospacing  PixelSpacing のタグを消したもの（画素間隔の無い画像）
使い方: python3 -I specBundleSynth.py <出力の親ディレクトリ> <乱数の種>
"""
import glob
import json
import os
import subprocess
import sys

import pydicom

parent, seed = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
out = {}
for i, name in enumerate(("spaced", "nospacing")):
    d = os.path.join(parent, name)
    os.makedirs(d, exist_ok=True)
    r = subprocess.run([sys.executable, "-I", os.path.join(here, "roiFeatureSynth.py"), d, str(int(seed) + i), "-1000", f"SYNTHSB-{name}"],
                       capture_output=True, text=True, check=True)
    info = json.loads(r.stdout)
    if name == "nospacing":
        for f in glob.glob(os.path.join(d, "*.dcm")):
            ds = pydicom.dcmread(f)
            del ds.PixelSpacing
            ds.save_as(f, enforce_file_format=True)
        assert "PixelSpacing" not in pydicom.dcmread(sorted(glob.glob(os.path.join(d, "*.dcm")))[0])
    info["name"] = name
    info["dir"] = d
    out[name] = info
print(json.dumps(out))
