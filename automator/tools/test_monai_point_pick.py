import unittest

import numpy as np

import monai_point_pick as pp


def phantom():
    img = np.full((30, 24, 20), -1000.0)
    img[2:28, 2:22, 2:18] = 40.0             # 体
    lab = np.zeros(img.shape, np.int32)
    lab[20:26, 14:20, 6:12] = 1             # 片隅のラベル
    lab[3:6, 3:6, 3:6] = 2                  # 別ラベル（陰性は別ラベルからも離す）
    return img, lab


class PointPick(unittest.TestCase):
    def test_positive_is_inside_label_and_negative_is_far_in_body(self):
        img, lab = phantom()
        pos, neg = pp.pick(img, lab, 1, (1.0, 1.0, 1.0), 8.0)
        self.assertEqual(lab[pos], 1)
        self.assertEqual(lab[neg], 0)
        self.assertGreater(img[neg], -300)
        from scipy import ndimage
        d = ndimage.distance_transform_edt(~(lab > 0))
        self.assertGreaterEqual(d[neg], 8.0)

    def test_negative_control_missing_label_and_no_far_voxel_raise(self):
        img, lab = phantom()
        with self.assertRaises(ValueError):
            pp.pick(img, lab, 9, (1.0, 1.0, 1.0))
        with self.assertRaises(ValueError):
            pp.pick(img, lab, 1, (1.0, 1.0, 1.0), 500.0)

    def test_to_lps_flips_x_and_y(self):
        aff = np.diag([2.0, 3.0, 4.0, 1.0])
        aff[:3, 3] = [10, 20, 30]
        self.assertEqual(pp.to_lps(aff, (1, 1, 1)), [-12.0, -23.0, 34.0])


if __name__ == "__main__":
    unittest.main()
