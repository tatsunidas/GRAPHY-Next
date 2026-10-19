"""圧縮 DICOM のテクスチャ解析スパイク用の合成 CT（compressedTextureCheck.ts から呼ぶ）。

同じ画素の 64×64×8 の CT を、非圧縮と各圧縮のシリーズとして書き出す（シリーズ・SOP の UID は別、
Study と FrameOfReference は共通）。JPEG 系は同梱 dcm4che の dcm2dcm、RLE は pydicom で圧縮する。

画素は符号なし 12 bit（Rescale -1024）。dcm4che の JPEG-LS Near-Lossless は符号付き 16 bit では
誤差 0 で書くので、非可逆の例が本当に値を変えるように符号なしにしている。

使い方: python3 -I compressedSynth.py <出力先> <乱数の種> <dcm2dcm のパス>
"""
import json
import os
import subprocess
import sys

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, RLELossless, generate_uid

H, W, D = 64, 64, 8
SPACING = [0.8, 0.8]
THICK = 2.0

# 名前 → (dcm2dcm の指定, 期待する転送構文, 非可逆か)。raw は非圧縮、rle は pydicom で作る。
VARIANTS = {
    "raw": (None, "1.2.840.10008.1.2.1", False),
    "jpll": ("--jpll", "1.2.840.10008.1.2.4.70", False),
    "jlsl": ("--jlsl", "1.2.840.10008.1.2.4.80", False),
    "j2kr": ("--j2kr", "1.2.840.10008.1.2.4.90", False),
    "rle": (None, "1.2.840.10008.1.2.5", False),
    "jlsn": ("--jlsn", "1.2.840.10008.1.2.4.81", True),
    "j2ki": ("--j2ki", "1.2.840.10008.1.2.4.91", True),
}

out = sys.argv[1]
rng = np.random.default_rng(int(sys.argv[2]))
dcm2dcm = sys.argv[3]
study, forr = generate_uid(), generate_uid()
yy, xx = np.meshgrid(np.arange(H) - 32, np.arange(W) - 32, indexing="ij")
vol = (rng.integers(0, 400, (D, H, W)) + np.hypot(xx, yy)[None] * 20).astype(np.uint16)

result = {"studyInstanceUid": study, "frameOfReferenceUID": forr, "rows": H, "columns": W,
          "pixelSpacing": SPACING, "sliceThickness": THICK, "series": {}}
for number, (name, (flag, ts, lossy)) in enumerate(VARIANTS.items(), start=1):
    series = generate_uid()
    src = os.path.join(out, f"{name}-src")
    dst = os.path.join(out, name)
    os.makedirs(src, exist_ok=True)
    os.makedirs(dst, exist_ok=True)
    frames = []
    for z in range(D):
        fm = FileMetaDataset()
        fm.MediaStorageSOPClassUID = CTImageStorage
        sop = generate_uid()
        fm.MediaStorageSOPInstanceUID = sop
        fm.TransferSyntaxUID = ExplicitVRLittleEndian
        d = Dataset()
        d.file_meta = fm
        d.SOPClassUID = CTImageStorage
        d.SOPInstanceUID = sop
        d.PatientName = "SYNTH^COMPRESSED"
        d.PatientID = "SYNTHCOMP"
        d.StudyInstanceUID = study
        d.SeriesInstanceUID = series
        d.Modality = "CT"
        d.SeriesNumber = number
        d.InstanceNumber = z + 1
        d.SeriesDescription = f"synthetic {name}"
        d.FrameOfReferenceUID = forr
        d.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ipp = [0.0, 0.0, z * THICK]
        d.ImagePositionPatient = ipp
        d.PixelSpacing = SPACING
        d.SliceThickness = THICK
        d.Rows = H
        d.Columns = W
        d.BitsAllocated = 16
        d.BitsStored = 12
        d.HighBit = 11
        d.SamplesPerPixel = 1
        d.PhotometricInterpretation = "MONOCHROME2"
        d.PixelRepresentation = 0
        d.RescaleSlope = 1
        d.RescaleIntercept = -1024
        d.WindowCenter = 40
        d.WindowWidth = 400
        d.StudyDate = "20260101"
        d.PixelData = vol[z].tobytes()
        f = f"ct_{z:03d}.dcm"
        if name == "rle":
            d.compress(RLELossless, generate_instance_uid=False)  # 既定では SOP の UID を作り直す
            d.save_as(os.path.join(dst, f), enforce_file_format=True)
        elif flag is None:
            d.save_as(os.path.join(dst, f), enforce_file_format=True)
        else:
            d.save_as(os.path.join(src, f), enforce_file_format=True)
            r = subprocess.run([dcm2dcm, flag, os.path.join(src, f), os.path.join(dst, f)],
                               capture_output=True, text=True)
            if r.returncode != 0:
                sys.exit(f"dcm2dcm {flag} failed: {r.stderr}")
        frames.append({"sopInstanceUid": sop, "imagePositionPatient": ipp})
    result["series"][name] = {"seriesInstanceUid": series, "transferSyntax": ts, "lossy": lossy,
                              "dir": dst, "frames": frames}
print(json.dumps(result))
