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
import urllib.request
import zipfile

URL = "https://zenodo.org/api/records/10047292/files/Totalsegmentator_dataset_v201.zip/content"
STRUCTURES = ["liver", "spleen", "kidney_left", "kidney_right", "pancreas", "vertebrae_L2", "vertebrae_L3", "vertebrae_L4",
              "iliopsoas_left", "iliopsoas_right", "autochthon_left", "autochthon_right"]


class HttpFile(io.RawIOBase):
    """Range 読みで seek できるファイル（zipfile に渡す）。"""

    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(req) as r:
            self.size = int(r.headers["Content-Range"].split("/")[1])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        if self.pos >= self.size:
            return 0
        end = min(self.size, self.pos + len(b)) - 1
        req = urllib.request.Request(self.url, headers={"Range": "bytes=%d-%d" % (self.pos, end)})
        with urllib.request.urlopen(req) as r:
            data = r.read()
        b[:len(data)] = data
        self.pos += len(data)
        return len(data)


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
