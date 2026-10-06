"""
TotalSegmentator データセット v2.0.1（Zenodo 10047292・CC BY 4.0）から、公式の test 分割の症例だけを取り出す。
23.6 GB の zip を丸ごとは落とさず、HTTP の Range で目次と必要なメンバーだけを読む。

    python fetch-totalseg-test-cases.py <出力フォルダ> [症例数] [study_type に含む語]

出力: <出力>/<image_id>/ct.nii.gz と segmentations/<構造>.nii.gz（STRUCTURES のみ）、<出力>/meta-test.csv
"""
import csv
import io
import os
import sys
import zipfile

from http_zip import HttpFile

URL = "https://zenodo.org/api/records/10047292/files/Totalsegmentator_dataset_v201.zip/content"
STRUCTURES = ["liver", "spleen", "kidney_left", "kidney_right", "pancreas", "vertebrae_L2", "vertebrae_L3", "vertebrae_L4",
              "iliopsoas_left", "iliopsoas_right", "autochthon_left", "autochthon_right"]


out = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
want = sys.argv[3] if len(sys.argv) > 3 else "abdomen"
os.makedirs(out, exist_ok=True)
zf = zipfile.ZipFile(io.BufferedReader(HttpFile(URL), buffer_size=1 << 20))
names = zf.namelist()
meta_name = next(x for x in names if x.endswith("meta.csv"))
prefix = meta_name[: -len("meta.csv")]
rows = list(csv.DictReader(io.TextIOWrapper(zf.open(meta_name), encoding="utf-8-sig"), delimiter=";"))
test = [r for r in rows if r.get("split") == "test"]
print("rows", len(rows), "test", len(test), "split counts",
      {s: sum(1 for r in rows if r.get("split") == s) for s in sorted({r.get("split") for r in rows})})
picked = [r for r in test if want.lower() in (r.get("study_type") or "").lower()][:n]
with open(os.path.join(out, "meta-test.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(test)
for r in picked:
    iid = r["image_id"]
    d = os.path.join(out, iid)
    os.makedirs(os.path.join(d, "segmentations"), exist_ok=True)
    for rel in ["ct.nii.gz"] + ["segmentations/%s.nii.gz" % s for s in STRUCTURES]:
        dst = os.path.join(d, rel)
        if not os.path.exists(dst):
            with zf.open(prefix + iid + "/" + rel) as src, open(dst, "wb") as f:
                f.write(src.read())
    print("fetched", iid, r.get("study_type"), r.get("age"), r.get("gender"), r.get("manufacturer", ""), flush=True)
