/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 一括の待ちの組のデータは、期限（2 時間）で消さずに持つ（hold）。終わったら discard で消える。 */
class ComputeDatasetHoldTest {

    @TempDir
    Path dir;

    /** 期限を過ぎたことにする（作成時刻を 5 時間前に置き換える）。 */
    @SuppressWarnings("unchecked")
    private void age(ComputeDatasetService svc, String handle) throws Exception {
        Field f = ComputeDatasetService.class.getDeclaredField("datasets");
        f.setAccessible(true);
        Map<String, ComputeDatasetService.Dataset> map = (Map<String, ComputeDatasetService.Dataset>) f.get(svc);
        ComputeDatasetService.Dataset d = map.get(handle);
        map.put(handle, new ComputeDatasetService.Dataset(d.handle(), d.format(), d.file(), d.bytes(), d.sha256(),
                d.instances(), d.burnedInstances(), d.sourceStudyUid(), d.sourceSeriesUid(), d.modality(),
                Instant.now().minus(Duration.ofHours(5))));
    }

    @Test
    void aHeldDatasetSurvivesTheTtlAndAnUnheldOneDoesNot() throws Exception {
        DatasetFixture fx = new DatasetFixture(dir);
        fx.writeCtSeries();
        ComputeDatasetService svc = fx.service();
        svc.useTempRoot(Files.createDirectories(dir.resolve("tmp")));
        ComputeDatasetService.Dataset held = svc.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES,
                ComputeDatasetService.Format.NPZ);
        ComputeDatasetService.Dataset plain = svc.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES,
                ComputeDatasetService.Format.NPZ);
        svc.hold(held.handle());
        age(svc, held.handle());
        age(svc, plain.handle());

        assertTrue(svc.get(held.handle()).isPresent(), "🔴 保持中のデータは期限を過ぎても残る（待ちの組が期限切れにならない）");
        assertTrue(svc.get(plain.handle()).isEmpty(), "（対照）保持していないものは期限で消える");
        assertFalse(Files.exists(plain.file()));
        assertTrue(Files.exists(held.file()));

        svc.discard(held.handle());
        assertTrue(svc.get(held.handle()).isEmpty(), "終わったら discard で消える");
        assertFalse(Files.exists(held.file()));
        // discard で保持の印も外れる（同じ handle を再び保持しても、無いものは保持できない）
        svc.hold(held.handle());
        assertEquals(0, svc.sweepOrphans(Duration.ZERO));
    }

    @Test
    void usableSpaceIsReported() throws Exception {
        ComputeDatasetService svc = new DatasetFixture(dir).service();
        svc.useTempRoot(dir);
        assertTrue(svc.usableSpace() > 0);
    }
}
