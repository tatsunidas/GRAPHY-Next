/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 異常終了で残った匿名化済みの一時フォルダの起動時掃除。 */
class ComputeDatasetSweepTest {

    @TempDir
    Path dir;

    private Path dirWithFile(String name, Instant mtime) throws Exception {
        Path d = Files.createDirectories(dir.resolve(name));
        Files.writeString(d.resolve("dataset.npz"), "x");
        Files.setLastModifiedTime(d, FileTime.from(mtime));
        return d;
    }

    @Test
    void removesOldLeftoversOnly() throws Exception {
        ComputeDatasetService svc = new DatasetFixture(dir.resolve("fx")).service();
        svc.useTempRoot(dir);
        Instant old = Instant.now().minus(Duration.ofHours(5));
        Path oldDir = dirWithFile("graphy-compute-old", old);
        Path freshDir = dirWithFile("graphy-compute-fresh", Instant.now());
        Path otherDir = dirWithFile("something-else", old);
        Path oldZip = Files.writeString(dir.resolve("graphy-compute-outputs-1.zip"), "z");
        Files.setLastModifiedTime(oldZip, FileTime.from(old));

        assertEquals(2, svc.sweepOrphans(Duration.ofHours(2)));

        assertFalse(Files.exists(oldDir), "古い取り残しは消す");
        assertFalse(Files.exists(oldZip), "古い取り残しの zip も消す");
        assertTrue(Files.exists(freshDir), "🔴 新しいものは消さない（別のアプリが同じ PC で使っているかもしれない）");
        assertTrue(Files.exists(otherDir), "🔴 名前が違うものは消さない");
        assertEquals(0, svc.sweepOrphans(Duration.ofHours(2)), "二度目は何もしない");
    }

    @Test
    void neverRemovesADatasetThatIsStillInTheTable() throws Exception {
        DatasetFixture fx = new DatasetFixture(dir);
        fx.writeCtSeries();
        ComputeDatasetService svc = fx.service();
        Path tmp = Files.createDirectories(dir.resolve("tmp"));
        svc.useTempRoot(tmp);
        ComputeDatasetService.Dataset live = svc.create(DatasetFixture.STUDY, DatasetFixture.CT_SERIES,
                ComputeDatasetService.Format.NPZ);
        Path stray = Files.createDirectories(tmp.resolve("graphy-compute-stray"));
        Files.writeString(stray.resolve("x"), "x");
        assertTrue(live.file().startsWith(tmp), "（前提）データセットは掃除の対象のフォルダの下にある");

        assertEquals(1, svc.sweepOrphans(Duration.ZERO), "年齢の条件を外しても、消えるのは表に無いものだけ");

        assertFalse(Files.exists(stray));
        assertTrue(Files.exists(live.file()), "🔴 表にあるデータセットは消さない");
        svc.discard(live.handle());
    }
}
