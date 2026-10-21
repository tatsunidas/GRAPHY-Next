"""monai_score.py の自己検査。標準 unittest。nibabel・pydicom・numpy が要る（requirements.txt）。

  python3 -I -m unittest test_monai_score   （automator/tools で）

固定データ testdata/seg_fixture.dcm は本体の SegExportService が書いたもの（作り方は testdata/README.md）。
正解（ラベルごとのボクセル中心の LPS 座標）は expected.json に、採点側とは別の式で書き出してある。
負例は、改変が実際に効いていること（画素や位置が変わったこと）を先に確かめてから、採点が落ちることを見る。
"""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest

import nibabel as nib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import monai_score as m  # noqa: E402

SEG = os.path.join(HERE, "testdata", "seg_fixture.dcm")
with open(os.path.join(HERE, "testdata", "expected.json"), encoding="utf-8") as _f:
    EXPECTED = json.load(_f)
LABELS = {int(k): v for k, v in EXPECTED["labels"].items()}
NAME_TO_VALUE = {v["name"]: k for k, v in LABELS.items()}


def points_of(vol: m.LabelVolume, value: int):
    idx = np.argwhere(vol.data == value)
    p = (vol.affine @ np.c_[idx, np.ones(len(idx))].T).T[:, :3]
    return sorted(map(tuple, np.round(p, 4)))


def make_reference(flip_rows: bool) -> m.LabelVolume:
    """正解の座標から、SEG とは軸の順も向きも違う格子の基準ラベルを作る（numpy だけ。採点側の関数は使わない）。"""
    # 軸 0 = スライス方向(0,0,-3)、軸 1 = 列方向(1.5,0,0)、軸 2 = 行方向(0,∓0.8,0)。原点は左上手前のボクセル中心。
    aff = np.eye(4)
    aff[:3, 0], aff[:3, 1] = (0, 0, -3.0), (1.5, 0, 0)
    aff[:3, 2] = (0, 0.8, 0) if flip_rows else (0, -0.8, 0)
    aff[:3, 3] = (-10.0, 20.0 - 0.8 * 4 if flip_rows else 20.0, 30.0)
    arr = np.zeros((4, 6, 5), np.int32)
    inv = np.linalg.inv(aff)
    for v, l in LABELS.items():
        for p in l["points_lps"]:
            i = np.rint(inv @ np.array([*p, 1.0]))[:3].astype(int)
            arr[tuple(i)] = v
    return m.LabelVolume(arr, aff, {})


def save_nifti(vol: m.LabelVolume, path: str) -> None:
    ras = np.diag([-1.0, -1.0, 1.0, 1.0]) @ vol.affine
    nib.Nifti1Image(vol.data.astype(np.int16), ras).to_filename(path)


class Positive(unittest.TestCase):
    def test_read_seg_matches_expected_coordinates(self):
        seg = m.read_seg(SEG)
        self.assertEqual(seg.names, {int(k): v["name"] for k, v in LABELS.items()})
        for v, l in LABELS.items():
            self.assertEqual(points_of(seg, v), sorted(map(tuple, np.round(np.array(l["points_lps"]), 4))), f"label {v}")
        self.assertAlmostEqual(seg.voxel_ml, EXPECTED["voxel_ml"], places=9)

    def test_perfect_prediction_scores_one_on_differently_oriented_reference(self):
        seg = m.read_seg(SEG)
        for flip in (False, True):
            ref = make_reference(flip)
            with tempfile.TemporaryDirectory() as d:  # NIfTI の RAS↔LPS 変換も通す
                p = os.path.join(d, "ref.nii.gz")
                save_nifti(ref, p)
                loaded = m.read_nifti_labels(p)
            r = m.score_volumes(seg, loaded, NAME_TO_VALUE)
            for name, row in r["labels"].items():
                self.assertEqual(row["dice"], 1.0, f"{name} flip={flip}")
                self.assertAlmostEqual(row["pred_ml"], row["ref_ml"], places=9)
                self.assertAlmostEqual(row["pred_ml"], len(LABELS[NAME_TO_VALUE[name]]["points_lps"]) * EXPECTED["voxel_ml"], places=9)

    def test_sub_voxel_shift_is_tolerated(self):
        ref = make_reference(False)
        moved = m.shift_mm(m.read_seg(SEG), 0.3, -0.2, 0.5)  # どの軸も半ボクセル未満
        self.assertFalse(np.allclose(moved.affine, m.read_seg(SEG).affine))
        r = m.score_volumes(moved, ref, NAME_TO_VALUE)
        self.assertTrue(all(row["dice"] == 1.0 for row in r["labels"].values()))

    def test_label_tables_and_verdict(self):
        self.assertTrue(m.compare_label_tables(NAME_TO_VALUE, dict(NAME_TO_VALUE))["match"])
        self.assertEqual(m.verdict(0.9, None), m.UNKNOWN)
        self.assertEqual(m.verdict(None, 0.5), m.PENDING)
        self.assertEqual(m.verdict(0.9, 0.9), m.PASS)
        self.assertEqual(m.verdict(0.89, 0.9), m.FAIL)

    def test_empty_both_is_not_a_perfect_score(self):
        d, why = m.dice(np.zeros((2, 2), bool), np.zeros((2, 2), bool))
        self.assertIsNone(d)
        self.assertTrue(why)


class Regions(unittest.TestCase):
    def test_region_is_the_union_of_labels(self):
        seg = m.read_seg(SEG)
        ref = make_reference(False)
        names = list(NAME_TO_VALUE)
        # 正例: 全ラベルの和は完全に一致する。1 ラベルだけの領域は、そのラベルの Dice と同じ
        r = m.score_volumes(seg, ref, NAME_TO_VALUE, {
            "all": {"seg": names, "ref": list(NAME_TO_VALUE.values())},
            "one": {"seg": names[:1], "ref": [NAME_TO_VALUE[names[0]]]},
        })
        self.assertEqual(r["regions"]["all"]["dice"], 1.0)
        self.assertEqual(r["regions"]["one"]["dice"], r["labels"][names[0]]["dice"])
        # 負例: 基準側の和にラベルを 1 つ足すと、完全一致ではなくなる（和集合の組み方が効いている）
        wrong = m.score_volumes(seg, ref, NAME_TO_VALUE, {"all": {"seg": names[:-1], "ref": list(NAME_TO_VALUE.values())}})
        self.assertLess(wrong["regions"]["all"]["dice"], 1.0)
        # SEG に無い名前は、0 や 1 で埋めず理由つきの None
        none = m.score_volumes(seg, ref, NAME_TO_VALUE, {"x": {"seg": ["no such"], "ref": [1]}})
        self.assertIsNone(none["regions"]["x"]["dice"])
        self.assertIn("no such", none["regions"]["x"]["reason"])


class Negative(unittest.TestCase):
    """採点が、壊れた入力で本当に落ちる（通ってしまわない）ことを確かめる。"""

    def setUp(self):
        self.seg = m.read_seg(SEG)
        self.ref = make_reference(False)

    def dices(self, seg):
        r = m.score_volumes(seg, self.ref, NAME_TO_VALUE)
        return {n: row["dice"] for n, row in r["labels"].items()}

    def test_baseline_is_perfect(self):  # 負例の前に、改変なしなら満点であること
        self.assertTrue(all(v == 1.0 for v in self.dices(self.seg).values()))

    def test_shift_20mm_each_axis_fails(self):
        for dx, dy, dz in ((20, 0, 0), (0, 20, 0), (0, 0, 20)):
            moved = m.shift_mm(self.seg, dx, dy, dz)
            self.assertFalse(np.allclose(moved.affine, self.seg.affine))
            d = self.dices(moved)
            self.assertTrue(all(v is None or v < 1.0 for v in d.values()), (dx, dy, dz, d))
            self.assertTrue(any(v == 0.0 for v in d.values()), (dx, dy, dz, d))  # 20 mm は全ラベルが外れる

    def test_flip_each_lps_axis_fails(self):
        for ax in "xyz":
            flipped = m.flip_lps(self.seg, ax)
            self.assertFalse(np.array_equal(flipped.data, self.seg.data), f"{ax}: 改変が効いていない")
            d = self.dices(flipped)
            self.assertTrue(min(v for v in d.values() if v is not None) < 1.0, (ax, d))

    def test_swapped_label_names_fail_both_table_and_dice(self):
        swapped = copy.deepcopy(self.seg)
        swapped.names = m.swap_label_names(self.seg.names, 1, 2)
        self.assertNotEqual(swapped.names, self.seg.names)
        by_name = {n: v for v, n in swapped.names.items()}
        self.assertFalse(m.compare_label_tables(NAME_TO_VALUE, by_name)["match"])
        d = self.dices(swapped)
        self.assertLess(d["left_thing"], 1.0)
        self.assertLess(d["right_thing"], 1.0)

    def test_missing_slice_fails(self):
        cut = copy.deepcopy(self.seg)
        before = cut.data.copy()
        cut.data[:, :, 1] = 0
        self.assertFalse(np.array_equal(before, cut.data))
        d = self.dices(cut)
        self.assertLess(d["left_thing"], 1.0)
        self.assertLess(d["right_thing"], 1.0)

    def test_wrong_nifti_axis_sign_fails(self):
        bad = make_reference(False)
        bad.affine = bad.affine.copy()
        bad.affine[0, 1] *= -1  # 左右の向きを取り違えた基準（宣言の誤り）
        bad.affine[0, 3] += 1.5 * 5
        d = {n: row["dice"] for n, row in m.score_volumes(self.seg, bad, NAME_TO_VALUE)["labels"].items()}
        self.assertTrue(all(v is None or v < 1.0 for v in d.values()), d)

    def test_unknown_name_is_reported_not_zero(self):
        r = m.score_volumes(self.seg, self.ref, {**NAME_TO_VALUE, "no_such": 9})
        self.assertIsNone(r["labels"]["no_such"]["dice"])
        self.assertTrue(r["labels"]["no_such"]["reason"])

    def test_non_label_nifti_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.nii.gz")
            nib.Nifti1Image(np.full((2, 2, 2), 0.5, np.float32), np.eye(4)).to_filename(p)
            with self.assertRaises(ValueError):
                m.read_nifti_labels(p)


class Cli(unittest.TestCase):
    def test_cli_writes_scores(self):
        with tempfile.TemporaryDirectory() as d:
            ref, mp, out = (os.path.join(d, n) for n in ("ref.nii.gz", "map.json", "out.json"))
            save_nifti(make_reference(True), ref)
            with open(mp, "w") as f:
                json.dump(NAME_TO_VALUE, f)
            r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "monai_score.py"), "--seg", SEG,
                                "--reference", ref, "--label-map", mp, "--out", out], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(out, encoding="utf-8") as f:
                res = json.load(f)
            self.assertTrue(all(row["dice"] == 1.0 for row in res["labels"].values()))


if __name__ == "__main__":
    unittest.main()
