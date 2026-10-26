"""receiveCompressCheck.ts 用の合成データ: 構造のある CT（64×64×3、16bit 符号付き）を 3 検査。

a と b は画素が同一（UID・患者だけ違う）。c は b と同じで 5×5 画素だけ +500（表示の比較器が差を見抜けるかの負例。+1 のような小さな差は階調の丸めで画面に出ないので、可逆性そのものは受信側の全バイト比較で保証する）。
画素は検査用で、臨床データではない。使い方: python3 -I receiveCompressSynth.py <出力ディレクトリ>
出力: <dir>/a b c に DICOM、<dir>/truth.json に各検査の UID・SOP UID。
"""
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
ROWS = COLS = 64
SLICES = 3


def pixels(k: int) -> np.ndarray:
    yy, xx = np.mgrid[0:ROWS, 0:COLS]
    body = (xx - 32) ** 2 + (yy - 32) ** 2 < 700
    rng = np.random.default_rng(100 + k)
    img = np.where(body, 40 + (yy % 9), -1000) + rng.integers(-3, 4, (ROWS, COLS))
    return img.astype("<i2")


def make_study(out: str, tag: str, bump: bool) -> dict:
    os.makedirs(out, exist_ok=True)
    study_uid, series_uid, for_uid = generate_uid(), generate_uid(), generate_uid()
    sops = []
    for k in range(SLICES):
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = CT_IMAGE_STORAGE
        sop_uid = generate_uid()
        sops.append(sop_uid)
        meta.MediaStorageSOPInstanceUID = sop_uid
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.ImplementationClassUID = generate_uid()
        ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
        ds.SOPClassUID, ds.SOPInstanceUID = CT_IMAGE_STORAGE, sop_uid
        ds.PatientID, ds.PatientName = f"RCSYN-{tag}", f"RCOMP^SYNTH{tag.upper()}"
        ds.StudyInstanceUID, ds.SeriesInstanceUID = study_uid, series_uid
        ds.StudyDate, ds.StudyTime = "20260101", "090000"
        ds.StudyDescription, ds.SeriesDescription = f"receive compress {tag}", "structured"
        ds.SeriesNumber, ds.InstanceNumber = 1, k + 1
        ds.Modality = "CT"
        ds.FrameOfReferenceUID = for_uid
        ds.ImagePositionPatient = [0, 0, float(k)]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing = [1.0, 1.0]
        ds.SliceThickness = 1.0
        ds.Rows, ds.Columns = ROWS, COLS
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 1
        ds.RescaleIntercept, ds.RescaleSlope = 0, 1
        px = pixels(k)
        if bump and k == 1:
            px[10:15, 10:15] += 500
        ds.PixelData = px.tobytes()
        ds.save_as(os.path.join(out, f"{tag}_{k + 1}.dcm"), enforce_file_format=True)
    return {"studyUid": study_uid, "seriesUid": series_uid, "sops": sops, "patientId": f"RCSYN-{tag}"}


if __name__ == "__main__":
    root = sys.argv[1]
    truth = {
        "a": make_study(os.path.join(root, "a"), "a", False),
        "b": make_study(os.path.join(root, "b"), "b", False),
        "c": make_study(os.path.join(root, "c"), "c", True),
    }
    with open(os.path.join(root, "truth.json"), "w") as f:
        json.dump(truth, f)
