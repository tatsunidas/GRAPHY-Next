"""retentionCheck.ts 用の合成データ: 3 患者・各 1 スタディ・1 シリーズ（CT、32×32×4）。

画素は検査用で、臨床データではない。使い方: python3 -I retentionSynth.py <出力ディレクトリ>
出力: <dir>/s1 s2 s3 に DICOM、<dir>/truth.json に各スタディの UID・患者名・SOP UID。
"""
import json
import os
import sys

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
ROWS = COLS = 32
SLICES = 4


def make_study(out: str, idx: int) -> dict:
    os.makedirs(out, exist_ok=True)
    study_uid, series_uid, for_uid = generate_uid(), generate_uid(), generate_uid()
    sops = []
    rng = np.random.default_rng(idx)
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
        ds.PatientID, ds.PatientName = f"RETSYN{idx}", f"RETENTION^SYNTH{idx}"
        ds.StudyInstanceUID, ds.SeriesInstanceUID = study_uid, series_uid
        ds.StudyDate, ds.StudyTime = f"2026010{idx}", "090000"
        ds.StudyDescription, ds.SeriesDescription = f"retention check {idx}", "noise"
        ds.SeriesNumber, ds.InstanceNumber = 1, k + 1
        ds.Modality = "CT"
        ds.FrameOfReferenceUID = for_uid
        ds.ImagePositionPatient = [0.0, 0.0, float(k)]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.PixelSpacing, ds.SliceThickness = [1.0, 1.0], 1.0
        ds.Rows, ds.Columns = ROWS, COLS
        ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit, ds.PixelRepresentation = 15, 1
        ds.RescaleIntercept, ds.RescaleSlope = 0, 1
        ds.WindowCenter, ds.WindowWidth = 200, 800
        ds.PixelData = rng.integers(-200, 400, size=(ROWS, COLS), dtype=np.int16).tobytes()
        ds.save_as(os.path.join(out, f"i_{k + 1:03d}.dcm"), enforce_file_format=True)
    return {"studyUid": study_uid, "seriesUid": series_uid, "patientName": f"RETENTION^SYNTH{idx}", "sops": sops}


def main(out: str) -> None:
    truth = [make_study(os.path.join(out, f"s{i}"), i) for i in (1, 2, 3)]
    json.dump(truth, open(os.path.join(out, "truth.json"), "w"))


if __name__ == "__main__":
    main(sys.argv[1])
