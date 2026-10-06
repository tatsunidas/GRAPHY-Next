"""
NLSTseg（Zenodo 14838349・CC BY 4.0・NLST の低線量 CT に肺癌の病変のマスク）から症例を取り出す。
zip（1 個 5〜7 GB）は丸ごとは落とさず、HTTP の Range で必要な症例のメンバーだけを読む。

    python fetch-nlstseg-cases.py <出力フォルダ> [症例数]

症例は Image.xlsx の並びの先頭から（選り好みしない）。出力: <出力>/<ID>/ct.nii.gz・tumor.nii.gz、<出力>/labels.csv（Label.xlsx の該当行）
"""
import io
import os
import sys
import zipfile

import pandas as pd

from http_zip import HttpFile

RECORD = "https://zenodo.org/api/records/14838349/files/%s/content"
ZIPS = ["2_LungTumor.zip", "3_LungTumor.zip", "4_LungTumor.zip", "5_LungTumor.zip", "6_LungTumor.zip", "7_LungTumor.zip"]

out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
os.makedirs(out, exist_ok=True)
table = os.path.join(out, "1_Table")
if not os.path.isdir(table):
    zipfile.ZipFile(io.BufferedReader(HttpFile(RECORD % "1_Table.zip"), buffer_size=1 << 20)).extractall(out)
images = pd.read_excel(os.path.join(table, "Image.xlsx"))
labels = pd.read_excel(os.path.join(table, "Label.xlsx"))
want = [str(x) for x in images["ID"].tolist()[:n]]
labels[labels["ID"].astype(str).isin(want)].to_csv(os.path.join(out, "labels.csv"), index=False, encoding="utf-8")

left = set(want)
for z in ZIPS:
    if not left:
        break
    zf = zipfile.ZipFile(io.BufferedReader(HttpFile(RECORD % z), buffer_size=1 << 20))
    for name in zf.namelist():
        parts = name.strip("/").split("/")
        if len(parts) != 3 or parts[1] not in left:
            continue
        cid, fname = parts[1], parts[2]
        kind = "ct.nii.gz" if fname.endswith("_CT.nii.gz") else "tumor.nii.gz" if fname.endswith("_tumor.nii.gz") else None
        if kind is None:
            continue
        d = os.path.join(out, cid)
        os.makedirs(d, exist_ok=True)
        dst = os.path.join(d, kind)
        if not os.path.exists(dst):
            with zf.open(name) as src, open(dst, "wb") as f:
                f.write(src.read())
        if all(os.path.exists(os.path.join(d, k)) for k in ("ct.nii.gz", "tumor.nii.gz")):
            left.discard(cid)
            print("fetched", cid, z, flush=True)
print("missing", sorted(left))
