"""monai_orient.py の自己検査。正例（期待の側に置いた模擬ラベル）で通り、鏡映した負例で落ちることを見る。

  python3 -I -m unittest test_monai_orient   （automator/tools で）
模擬ラベルは ct-basic の格子に直接作る（Bundle の出力ではない。検出器そのものの検査）。
"""
import glob
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import monai_orient as o  # noqa: E402
import monai_score as m  # noqa: E402

CT = os.path.join(HERE, "..", "fixtures", "ct-basic")


@unittest.skipUnless(glob.glob(os.path.join(CT, "*.dcm")), "ct-basic が無い")
class OrientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import pydicom

        cls.body = o.body_centroid_lps(CT)
        files = sorted(glob.glob(os.path.join(CT, "*.dcm")))
        d, d1 = pydicom.dcmread(files[0]), pydicom.dcmread(files[1])
        n = len(files)
        dz = float(d1.ImagePositionPatient[2]) - float(d.ImagePositionPatient[2])  # ct-basic はファイル順に z が減る
        ps = float(d.PixelSpacing[0])
        aff = np.eye(4)
        aff[:3, :3] = np.diag([ps, ps, dz])
        aff[:3, 3] = [float(x) for x in d.ImagePositionPatient]
        cls.aff, cls.shape = aff, (512, 512, n)

    def make_label(self, offset):
        """体の重心 + offset(mm) を中心とする半径 20 mm の球（LPS で格子の外に出ない大きさ）。"""
        ijk = np.indices(self.shape).reshape(3, -1).T
        p = (self.aff @ np.c_[ijk, np.ones(len(ijk))].T).T[:, :3]
        sel = np.linalg.norm(p - (self.body + offset), axis=1) <= 20
        data = np.zeros(self.shape, np.int16)
        data.reshape(-1)[sel] = 1
        return m.LabelVolume(data, self.aff, {1: "spleen"})

    def test_body_centroid_is_inside_grid(self):
        a, b = self.aff[:3, 3], (self.aff @ np.r_[self.shape, 1])[:3]
        lo, hi = np.minimum(a, b), np.maximum(a, b)
        self.assertTrue(np.all(self.body > lo) and np.all(self.body < hi), self.body)

    def test_positive_passes_and_flips_fail(self):
        vol = self.make_label(np.array([60.0, 40.0, 0.0]))
        self.assertGreater(int((vol.data == 1).sum()), 100)  # 模擬ラベルが実際に作れている
        expect = {"x": +1, "y": +1}
        base = o.check_side(o.label_centroid_lps(vol, 1), self.body, expect)
        self.assertTrue(base["all_ok"], base)
        for ax in "xy":
            flipped = m.flip_lps(vol, ax)
            self.assertFalse(np.array_equal(flipped.data, vol.data))  # 反転が効いている
            r = o.check_side(o.label_centroid_lps(flipped, 1), self.body, expect)
            self.assertFalse(r[ax]["ok"], (ax, r))
            self.assertFalse(r["all_ok"])


if __name__ == "__main__":
    unittest.main()
