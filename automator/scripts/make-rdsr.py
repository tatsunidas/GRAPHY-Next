#!/usr/bin/env python3
"""X-Ray Radiation Dose SR（RDSR）の合成データを作る。

`fw/angio-design.md` A9 の実機検証用。**実 RDSR が手元に無い**ため
（設計 §20-5 の未決事項）、TID 10001/10003 の入れ子構造を実物どおりに組んだ
合成 SR を作る。パーサは**コード値ではなく CodeMeaning で突き合わせる**設計なので、
コード値が実機と多少違っても検証の意味は保たれる。

使い方:  python3 automator/scripts/make-rdsr.py <出力先.dcm> [<参照する XA の .dcm>]

参照 XA を渡すと、患者・スタディの識別情報をそこから引き継ぐ（同じ検査に紐づく
RDSR になり、検査単位の線量サマリを実際の画面で確認できる）。
"""
import sys

import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

RDSR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.88.67"


def code(value: str, meaning: str, scheme: str = "DCM") -> Dataset:
    ds = Dataset()
    ds.CodeValue = value
    ds.CodingSchemeDesignator = scheme
    ds.CodeMeaning = meaning
    return ds


def container(code_value: str, meaning: str) -> Dataset:
    ds = Dataset()
    ds.RelationshipType = "CONTAINS"
    ds.ValueType = "CONTAINER"
    ds.ContinuityOfContent = "SEPARATE"
    ds.ConceptNameCodeSequence = [code(code_value, meaning)]
    ds.ContentSequence = []
    return ds


def num(code_value: str, meaning: str, value: float, unit: str) -> Dataset:
    ds = Dataset()
    ds.RelationshipType = "CONTAINS"
    ds.ValueType = "NUM"
    ds.ConceptNameCodeSequence = [code(code_value, meaning)]
    measured = Dataset()
    measured.NumericValue = str(value)
    measured.MeasurementUnitsCodeSequence = [code(unit, unit, "UCUM")]
    ds.MeasuredValueSequence = [measured]
    return ds


def code_item(code_value: str, meaning: str, value_meaning: str) -> Dataset:
    ds = Dataset()
    ds.RelationshipType = "CONTAINS"
    ds.ValueType = "CODE"
    ds.ConceptNameCodeSequence = [code(code_value, meaning)]
    ds.ConceptCodeSequence = [code("x", value_meaning)]
    return ds


def uid_item(code_value: str, meaning: str, uid: str) -> Dataset:
    ds = Dataset()
    ds.RelationshipType = "CONTAINS"
    ds.ValueType = "UIDREF"
    ds.ConceptNameCodeSequence = [code(code_value, meaning)]
    ds.UID = uid
    return ds


def build(reference: "pydicom.dataset.Dataset | None") -> FileDataset:
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = RDSR_SOP_CLASS
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = FileDataset("rdsr.dcm", {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.SOPClassUID = RDSR_SOP_CLASS
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.Modality = "SR"
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 9500
    ds.InstanceNumber = 1
    ds.ContentDate = "20260814"
    ds.ContentTime = "093000"
    ds.Manufacturer = "SYNTHETIC"
    ds.SpecificCharacterSet = "ISO_IR 192"
    ds.CompletionFlag = "COMPLETE"
    ds.VerificationFlag = "UNVERIFIED"

    if reference is not None:
        for kw in (
            "PatientID", "PatientName", "PatientBirthDate", "PatientSex",
            "StudyInstanceUID", "StudyDate", "StudyTime", "StudyID", "AccessionNumber",
        ):
            if kw in reference:
                setattr(ds, kw, getattr(reference, kw))
    else:
        ds.PatientID = "RDSR-TEST"
        ds.PatientName = "RDSR^TEST"
        ds.StudyInstanceUID = generate_uid()
        ds.StudyDate = "20260814"

    ds.ValueType = "CONTAINER"
    ds.ContinuityOfContent = "SEPARATE"
    ds.ConceptNameCodeSequence = [code("113701", "X-Ray Radiation Dose Report")]

    root = []

    # ── 積算線量（TID 10001 の Accumulated X-Ray Dose Data 相当）─────────
    acc = container("113702", "Accumulated X-Ray Dose Data")
    acc.ContentSequence = [
        num("113722", "Dose Area Product Total", 12.5, "Gy.m2"),
        num("113725", "Dose (RP) Total", 340.0, "mGy"),
        num("113730", "Fluoro Time", 180.0, "s"),
    ]
    root.append(acc)

    # ── 照射イベント（TID 10003 相当）×3 ────────────────────────────────
    events = [
        ("Fluoroscopy", 3.5, -30.0, 2.0),
        ("Stationary Acquisition", 9.0, 29.8, 28.5),
        ("Stationary Acquisition", 6.25, -81.0, 0.0),
    ]
    for i, (kind, dap, primary, secondary) in enumerate(events, start=1):
        ev = container("113706", "Irradiation Event X-Ray Data")
        ev.ContentSequence = [
            code_item("113721", "Irradiation Event Type", kind),
            uid_item("113769", "Irradiation Event UID", f"1.2.826.0.1.3680043.9.7.9500.{i}"),
            num("113738", "Dose Area Product", dap, "Gy.m2"),
            num("113734", "Positioner Primary Angle", primary, "deg"),
            num("113735", "Positioner Secondary Angle", secondary, "deg"),
            num("113733", "KVP", 80.0 + i, "kV"),
        ]
        root.append(ev)

    ds.ContentSequence = root
    return ds


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    out = sys.argv[1]
    reference = None
    if len(sys.argv) > 2:
        reference = pydicom.dcmread(sys.argv[2], stop_before_pixels=True)
    ds = build(reference)
    ds.save_as(out, enforce_file_format=True)
    print(f"{out}  study={ds.StudyInstanceUID}  events=3")


if __name__ == "__main__":
    main()
