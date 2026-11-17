/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * dcm4che の実機ツールを要るテストの「飛ばす／落とす」切り替え。普段はツールが無ければ飛ばす。
 * {@code GRAPHY_REQUIRE_DCM4CHE_TOOLS=1}（リリースの dcm4che-gate）のときは、飛ばさず落とす
 * （ツールの取得に失敗して、通信の検査が黙って未実行になるのを防ぐ）。
 */
final class Dcm4cheToolsGate {

    private Dcm4cheToolsGate() {}

    static boolean required() {
        return "1".equals(System.getenv("GRAPHY_REQUIRE_DCM4CHE_TOOLS"));
    }

    static void require(boolean present, String message) {
        if (!present && required()) {
            fail("🔴 GRAPHY_REQUIRE_DCM4CHE_TOOLS=1 なのにツールが無い（黙って未実行にしない）: " + message);
        }
        assumeTrue(present, message);
    }
}
