#!/usr/bin/env python3
# GRAPHY-Next Benchmark (wrap_public_xa check)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
"""`wrap_public_xa.py` が正しい XA を吐くかを、合成入力で確かめる。

`fw/angio-design.md` §16.1 / §16.2.1。

なぜ要るのか
------------
このラッパの要点は「**何を書くか**」ではなく「**何を書かないか**」にある。
空間校正・投影幾何のタグを埋めてしまうと、未校正の画像が mm で測られ、
**値がそれらしいので誰も気付かない**（§22.3 の H35 と同じ失敗）。
書かないことは目で見て気付けないので、機械で確かめる。

公開データそのものは大きく（ARCADE 451MB / DIAS 219MB）、ライセンス上も
リポジトリに置けない。ここでは**合成した画像**を入力にして、ラッパの振る舞い
（タグ・フレーム数・画素の往復・決定性・寸法不一致の拒否）だけを確かめる。
⚠️ 実データでの取り込み確認は別途、手元にデータを置いて行うこと。

使い方:
    python3 check_wrap_public_xa.py
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile

import numpy as np
import pydicom
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wrap_public_xa import SPECS, build_xa, collect_jobs, _load_frames  # noqa: E402

passed = 0
failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global passed, failures
    if ok:
        passed += 1
        print(f"  ✓ {label}" + (f"  — {detail}" if detail else ""))
    else:
        failures += 1
        print(f"  ✗ {label}" + (f"  — {detail}" if detail else ""))


def _synth_frame(rows: int, cols: int, phase: float) -> np.ndarray:
    """血管らしい暗い帯を 1 本描いた 8bit 画像。中身は何でもよいが、
    定数画像だと画素の往復チェックが素通りするので変化を付ける。"""
    yy, xx = np.mgrid[0:rows, 0:cols]
    centre = rows / 2 + 12.0 * np.sin(xx / 40.0 + phase)
    dist = np.abs(yy - centre)
    vessel = np.clip(1.0 - dist / 6.0, 0.0, 1.0)
    img = 220.0 - 170.0 * vessel
    return np.clip(img, 0, 255).astype(np.uint8)


def _write_pngs(root: str, groups: dict[str, int], rows: int = 64, cols: int = 80) -> None:
    for name, n in groups.items():
        d = os.path.join(root, name)
        os.makedirs(d, exist_ok=True)
        for i in range(n):
            Image.fromarray(_synth_frame(rows, cols, i * 0.7)).save(
                os.path.join(d, f"f{i:03d}.png"))


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="wrapxa-")
    try:
        src = os.path.join(tmp, "src")
        _write_pngs(src, {"video01": 10, "video02": 4})

        # ── 1. 連続フレームは 1 ディレクトリ = 1 シリーズに束ねる ────────────
        print("\n----- グループ化 -----")
        seq_spec = SPECS["cadica"]
        jobs = collect_jobs(src, seq_spec)
        check(len(jobs) == 2, "連続フレームは 1 ディレクトリ = 1 シリーズ",
              f"{len(jobs)} シリーズ")
        check(sorted(len(j.paths) for j in jobs) == [4, 10],
              "各シリーズのフレーム数が入力どおり",
              str(sorted(len(j.paths) for j in jobs)))

        # 独立した静止画は束ねない（フレームごとに別患者になるため）
        still_spec = SPECS["arcade"]
        still_jobs = collect_jobs(src, still_spec)
        check(len(still_jobs) == 14 and all(len(j.paths) == 1 for j in still_jobs),
              "独立した静止画は束ねず 1 枚 1 シリーズ",
              f"{len(still_jobs)} シリーズ・すべて 1 フレーム")

        # ── 2. 出来上がった XA のタグ ────────────────────────────────────
        print("\n----- 書き出した DICOM -----")
        job = [j for j in jobs if j.paths and len(j.paths) == 10][0]
        frames, bits = _load_frames(job.paths)
        ds = build_xa(frames, bits, spec=seq_spec, group_key=job.group_key,
                      attribution=seq_spec.attribution, fps=seq_spec.fps)
        out = os.path.join(tmp, "out.dcm")
        ds.save_as(out, enforce_file_format=True)
        back = pydicom.dcmread(out)

        check(back.SOPClassUID == "1.2.840.10008.5.1.4.1.1.12.1",
              "SOP Class が XA Image Storage", str(back.SOPClassUID))
        check(back.Modality == "XA", "Modality が XA")
        check(int(back.NumberOfFrames) == 10, "NumberOfFrames", str(back.NumberOfFrames))
        check(back.PhotometricInterpretation == "MONOCHROME2", "MONOCHROME2")
        check(int(back.BitsAllocated) == 8 and int(back.BitsStored) == 8,
              "8bit のまま格納", f"allocated={back.BitsAllocated}")
        check(back.PixelIntensityRelationship == "LIN",
              "PixelIntensityRelationship=LIN（DSA が対数変換を要ると判断できる）")

        # 🚨 本命: 幾何タグを書いていないこと
        print("\n----- 🚨 書いていないこと（このラッパの要点）-----")
        for tag in ("PixelSpacing", "ImagerPixelSpacing", "DistanceSourceToDetector",
                    "DistanceSourceToPatient", "EstimatedRadiographicMagnificationFactor",
                    "PositionerPrimaryAngle", "PositionerSecondaryAngle",
                    "PixelSpacingCalibrationType"):
            check(tag not in back, f"{tag} を書いていない",
                  "" if tag not in back else f"🔴 {getattr(back, tag, None)} が入っている")

        # ── 3. 時間軸 ────────────────────────────────────────────────────
        print("\n----- 時間軸 -----")
        check("FrameTime" in back, "マルチフレームには FrameTime がある",
              str(back.get("FrameTime")))
        check(abs(float(back.FrameTime) - 100.0) < 1e-6, "FrameTime が fps と整合",
              f"{back.FrameTime} ms @ {seq_spec.fps} fps")
        check(int(back.CineRate) == 10, "CineRate", str(back.CineRate))

        single = build_xa(frames[:1], bits, spec=still_spec, group_key="x",
                          attribution=still_spec.attribution, fps=still_spec.fps)
        check("FrameTime" not in single,
              "単一フレームには FrameTime を書かない（時間軸が無いため）")

        # ── 4. 画素が往復すること ────────────────────────────────────────
        print("\n----- 画素・帰属・決定性 -----")
        check(np.array_equal(back.pixel_array, frames),
              "画素が入力と一致（往復で壊れない）",
              f"shape={back.pixel_array.shape}")
        check("CC BY 4.0" in back.ImageComments,
              "出典表記を画像に焼き込んでいる", back.ImageComments[:48] + "...")
        check(back.PatientIdentityRemoved == "YES", "PatientIdentityRemoved=YES")

        # 決定性: 同じ入力なら同じバイト列（bench の作法）
        out2 = os.path.join(tmp, "out2.dcm")
        build_xa(frames, bits, spec=seq_spec, group_key=job.group_key,
                 attribution=seq_spec.attribution, fps=seq_spec.fps
                 ).save_as(out2, enforce_file_format=True)
        md5 = [hashlib.md5(open(p, "rb").read()).hexdigest() for p in (out, out2)]
        check(md5[0] == md5[1], "決定的（同じ入力なら同じバイト列）", md5[0][:16])

        # UID がシリーズごとに違うこと
        other = [j for j in jobs if len(j.paths) == 4][0]
        f2, b2 = _load_frames(other.paths)
        ds2 = build_xa(f2, b2, spec=seq_spec, group_key=other.group_key,
                       attribution=seq_spec.attribution, fps=seq_spec.fps)
        check(ds2.SeriesInstanceUID != back.SeriesInstanceUID,
              "シリーズごとに SeriesInstanceUID が違う")

        # ── 4b. 平置き配布のグループ化（DIAS の形）────────────────────────
        # 実データで踏んだ形: 1 ディレクトリに何本ものシーケンスが平置きされ、
        # 同じ階層に正解マスクもある。ディレクトリ単位で束ねると全部 1 本に潰れる。
        print("\n----- 平置き配布のグループ化 -----")
        flat = os.path.join(tmp, "flat")
        os.makedirs(os.path.join(flat, "images"), exist_ok=True)
        os.makedirs(os.path.join(flat, "labels"), exist_ok=True)
        for s_id, n in (("1", 12), ("2", 5)):
            for i in range(n):
                Image.fromarray(_synth_frame(48, 60, i * 0.5)).save(
                    os.path.join(flat, "images", f"image_s{s_id}_i{i}.png"))
        Image.fromarray(_synth_frame(48, 60, 0.0)).save(
            os.path.join(flat, "labels", "label_s1.png"))

        dias = SPECS["dias"]
        fjobs = collect_jobs(flat, dias)
        check(len(fjobs) == 2, "ファイル名の s トークンでシリーズを切り分ける",
              f"{len(fjobs)} シリーズ（ディレクトリ単位なら 1 本に潰れる）")
        check(sorted(len(j.paths) for j in fjobs) == [5, 12],
              "各シリーズのフレーム数", str(sorted(len(j.paths) for j in fjobs)))
        check(all("labels" not in q for j in fjobs for q in j.paths),
              "正解マスク（labels/）を取り込まない")

        twelve = [j for j in fjobs if len(j.paths) == 12][0]
        order = [int(os.path.basename(q).split("_i")[1].split(".")[0]) for q in twelve.paths]
        check(order == list(range(12)),
              "フレームを整数順に並べる（名前順だと i10 が i2 より先に来る）",
              f"{order[:5]}...{order[-3:]}")

        # ── 5. 寸法違いは黙って直さない ──────────────────────────────────
        print("\n----- 壊れた入力 -----")
        bad = os.path.join(tmp, "bad", "v")
        os.makedirs(bad, exist_ok=True)
        Image.fromarray(_synth_frame(64, 80, 0.0)).save(os.path.join(bad, "a.png"))
        Image.fromarray(_synth_frame(50, 70, 0.0)).save(os.path.join(bad, "b.png"))
        try:
            _load_frames(sorted(os.path.join(bad, n) for n in os.listdir(bad)))
            check(False, "シリーズ内で寸法が違えば拒否する", "🔴 通ってしまった")
        except ValueError as e:
            check(True, "シリーズ内で寸法が違えば拒否する（黙って引き伸ばさない）",
                  str(e)[:52] + "...")

        print("\n===== wrap_public_xa チェック =====")
        print(f"合格 {passed} / 失敗 {failures}")
        return 1 if failures else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
