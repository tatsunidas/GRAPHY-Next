#!/usr/bin/env python3
"""合成のマルチエコー MR ファントム（DICOM）を作る。患者情報を含まない。T2 マップの検査（mrQuantPhantomCheck）で使う。

既知の T2（体 70 ms・円柱 40/60/80/120/200 ms・測れない円柱 5000 ms）から S = S0·exp(-TE/T2) を TE ごとに作る。
EchoTime (0018,0081) と EchoNumbers (0018,0086) を書く。向きは IOP が単位行列・IPP が z 方向に等間隔（LPS）。

使い方:
  python3 make-t2-phantom.py <出力フォルダ> [--te 10,20,40,80,160] [--form series|channels] [--snr 30] [--seed 1]
      [--no-echo-numbers] [--no-te] [--mask-background] [--reverse-z] [--patient-id PH-T2] [--truth]
  --form series   : TE ごとに別シリーズ（<出力>/te<TE>/z01.dcm …）
  --form channels : 1 シリーズに全エコー（EchoNumbers で C 分割。<出力>/echoes/…）
  --snr S         : 体の最短 TE の信号 / σ。全画素（背景も）に Rician 雑音。0 = 雑音なし
  --no-echo-numbers: EchoNumbers を書かない（本体が EchoTime で C 分割する経路）
  --no-te         : EchoTime を書かない（TE が読めない負例）
  --mask-background: 体の外を厳密に 0 にする（装置の noise masking 相当）
  --reverse-z     : IPP を z 方向に減る順で書く（InstanceNumber の順と位置の順が逆）
  --z-t2          : 体（円柱以外）の T2 を位置の z で変える（70 + 10·(z の位置 index) ms）。スライス順の対応を検査するため
出力: truth.json（--truth のとき。t2・sigma・te・各円柱の位置）。
"""
import argparse
import json
import os

import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

NX = NY = 96
NZ = 8
PS = 2.5      # mm
ST = 5.0      # mm
S0 = 30000.0
BODY_T2 = 70.0
DISKS = [  # (中心 x, 中心 y, 半径 px, T2 [ms])
    (30, 32, 7, 40.0), (66, 32, 7, 60.0), (48, 48, 7, 80.0), (30, 66, 7, 120.0), (66, 66, 7, 200.0), (48, 18, 5, 5000.0),
]


def phantom(body_t2=BODY_T2):
    yy, xx = np.mgrid[0:NY, 0:NX]
    body = ((xx - 47.5) / 42.0) ** 2 + ((yy - 47.5) / 40.0) ** 2 <= 1.0
    t2 = np.where(body, body_t2, 0.0)
    for cx, cy, r, v in DISKS:
        t2 = np.where((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r, v, t2)
    return body, t2


def write_instance(path, *, study_uid, for_uid, series_uid, series_number, series_desc, instance_number, z, pix, te, echo_no, args, patient_id):
    sop = generate_uid()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = generate_uid()
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = sop
    ds.PatientName = "PHANTOM^T2"
    ds.PatientID = patient_id
    ds.StudyInstanceUID = study_uid
    ds.StudyDate = "20261109"
    ds.StudyDescription = "Digital multi-echo T2 phantom"
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = series_number
    ds.SeriesDescription = series_desc
    ds.Modality = "MR"
    ds.ImageType = ["ORIGINAL", "PRIMARY", "M", "NONE"]
    ds.FrameOfReferenceUID = for_uid
    ds.InstanceNumber = instance_number
    ds.AcquisitionNumber = 1
    ds.Rows, ds.Columns = NY, NX
    ds.PixelSpacing = [PS, PS]
    ds.SliceThickness = ST
    ds.SpacingBetweenSlices = ST
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [-NX * PS / 2, -NY * PS / 2, z * ST]
    ds.RepetitionTime = 3000.0
    if not args.no_te:
        ds.EchoTime = float(te)
    if not args.no_echo_numbers:
        ds.EchoNumbers = echo_no
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.RescaleIntercept = 0
    ds.RescaleSlope = 1
    ds.WindowCenter = S0 / 2
    ds.WindowWidth = S0
    ds.PixelData = pix.tobytes()
    ds.save_as(path, enforce_file_format=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--te", default="10,20,40,80,160")
    ap.add_argument("--form", choices=["series", "channels"], default="series")
    ap.add_argument("--snr", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--no-echo-numbers", action="store_true")
    ap.add_argument("--no-te", action="store_true")
    ap.add_argument("--mask-background", action="store_true")
    ap.add_argument("--reverse-z", action="store_true")
    ap.add_argument("--z-t2", action="store_true")
    ap.add_argument("--patient-id", default="PH-T2")
    ap.add_argument("--truth", action="store_true")
    args = ap.parse_args()
    tes = [float(x) for x in args.te.split(",")]
    body, t2 = phantom()
    sigma = (S0 * np.exp(-tes[0] / BODY_T2)) / args.snr if args.snr > 0 else 0.0
    rng = np.random.default_rng(args.seed)
    study_uid, for_uid = generate_uid(), generate_uid()
    series_uid = generate_uid()  # channels 形の 1 シリーズ
    instance_no = 0
    for e, te in enumerate(tes):
        d = os.path.join(args.out, f"te{int(te) if te == int(te) else te}" if args.form == "series" else "echoes")
        os.makedirs(d, exist_ok=True)
        if args.form == "series":
            series_uid = generate_uid()
        for z in range(NZ):
            # --reverse-z: InstanceNumber は 1.. のままで、位置が減る順に書く
            zpos = (NZ - 1 - z) if args.reverse_z else z
            _, t2z = phantom(BODY_T2 + 10.0 * zpos if args.z_t2 else BODY_T2)
            sig = np.where(t2z > 0, S0 * np.exp(-te / np.where(t2z > 0, t2z, 1.0)), 0.0)
            if sigma > 0:
                # 各スライスで独立な雑音（Rician）
                re = sig + sigma * rng.standard_normal(sig.shape)
                im = sigma * rng.standard_normal(sig.shape)
                img = np.hypot(re, im)
                if args.mask_background:
                    img = np.where(body, img, 0.0)
            else:
                img = sig
            pix = np.clip(np.rint(img), 0, 65535).astype("<u2")
            instance_no += 1
            write_instance(
                os.path.join(d, f"e{e + 1:02d}z{z + 1:02d}.dcm"),
                study_uid=study_uid, for_uid=for_uid, series_uid=series_uid,
                series_number=(1 if args.form == "channels" else e + 1),
                series_desc=("Phantom T2 multiecho" if args.form == "channels" else f"Phantom T2 TE{int(te) if te == int(te) else te}"),
                instance_number=(instance_no if args.form == "channels" else z + 1),
                z=zpos, pix=pix, te=te, echo_no=e + 1, args=args, patient_id=args.patient_id)
    if args.truth:
        with open(os.path.join(args.out, "truth.json"), "w") as f:
            json.dump({"nx": NX, "ny": NY, "nz": NZ, "S0": S0, "te": tes, "sigma": float(sigma), "t2": t2.tolist(),
                       "disks": [{"cx": c, "cy": y, "r": r, "t2": v} for c, y, r, v in DISKS], "body_t2": BODY_T2, "z_t2": bool(args.z_t2), "z_step_mm": ST}, f)
    print("ok", args.out)


if __name__ == "__main__":
    main()
