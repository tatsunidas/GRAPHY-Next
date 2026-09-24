/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 焼き込みの<b>申告</b>が事実と一致するかの検査。
 *
 * <h2>なぜこのテストがあるか</h2>
 * 2026-09-24 の実測で、<b>63 フレームのうち 1 枚だけ塗ったインスタンスに
 * {@code BurnedInAnnotation=NO} と 113101「Clean Pixel Data Option」が付いていた</b>。
 * 残り 62 枚には患者名が焼き込まれたまま。受け取った側はこのタグを信用して検証しないので、
 * <b>匿名化しないより危険</b>な状態だった（2026-09-07 に直したのと同じ種類の偽申告の再発）。
 *
 * <p>🔴 <b>この壊れ方は画面でも出力ファイルの属性でも気づけない。</b> タグは「きれい」と
 * 言っており、画素を 1 フレームずつ見に行って初めて食い違いが分かる。だから数値で固定する。
 */
class AnonymizeBurnScopeTest {

    private static final String STUDY = "1.2.826.0.1.3680043.10.1338.1";
    private static final String SERIES = "1.2.826.0.1.3680043.10.1338.2";
    private static final String SOP = "1.2.826.0.1.3680043.10.1338.3";

    private static final int COLS = TestDicomFiles.COLS;
    private static final int ROWS = TestDicomFiles.ROWS;
    private static final int FRAMES = 4;

    // ------------------------------------------------------------------------

    @Test
    void 一部のフレームだけ塗ったら除去済みと申告しない(@TempDir Path dir) throws Exception {
        Path src = TestDicomFiles.writeUncompressed(dir.resolve("in.dcm"), STUDY, SERIES, SOP, FRAMES, 200);
        // 「描いたフレームだけ」に絞ったマスク（frames = [1]）。
        AnonymizeService.Result r = run(dir, src, maskOnFrames(List.of(1)));

        assertEquals(0, r.burnedInstances(), "全フレームを塗れていないので『塗れた』には数えない");
        assertEquals(1, r.partiallyBurnedInstances(), "一部だけ塗ったことは件数で見せる");

        Attributes out = readOutput(dir);
        assertFalse(hasMethodCode(out, "113101"),
                "🔴 1 枚しか塗っていないのに Clean Pixel Data を申告してはいけない");
        assertEquals("YES", out.getString(Tag.BurnedInAnnotation),
                "🔴 原本の YES を NO に書き換えない（残っているものを『消した』と言わない）");

        byte[] px = out.getBytes(Tag.PixelData);
        assertTrue(isBlank(px, 1), "指定したフレーム 1 は塗られている");
        assertFalse(isBlank(px, 0), "指定していないフレーム 0 は塗られていない");
        assertFalse(isBlank(px, 3), "指定していないフレーム 3 は塗られていない");
    }

    @Test
    void 全フレームを塗ったら除去済みと申告する(@TempDir Path dir) throws Exception {
        Path src = TestDicomFiles.writeUncompressed(dir.resolve("in.dcm"), STUDY, SERIES, SOP, FRAMES, 200);
        // frames が空＝そのインスタンスの全フレーム（2026-09-24 以降の既定）。
        AnonymizeService.Result r = run(dir, src, maskOnFrames(List.of()));

        assertEquals(1, r.burnedInstances());
        assertEquals(0, r.partiallyBurnedInstances());

        Attributes out = readOutput(dir);
        assertTrue(hasMethodCode(out, "113101"), "全フレーム塗れたときだけ申告する");
        assertEquals("NO", out.getString(Tag.BurnedInAnnotation));

        byte[] px = out.getBytes(Tag.PixelData);
        for (int f = 0; f < FRAMES; f++) {
            assertTrue(isBlank(px, f), "フレーム " + f + " が塗られている");
        }
    }

    @Test
    void マスクの無いシリーズは画素も申告も変えない(@TempDir Path dir) throws Exception {
        Path src = TestDicomFiles.writeUncompressed(dir.resolve("in.dcm"), STUDY, SERIES, SOP, FRAMES, 200);
        AnonymizeService.Result r = run(dir, src, null);

        assertEquals(0, r.burnedInstances());
        assertEquals(1, r.notBurnedInstances());

        Attributes out = readOutput(dir);
        assertFalse(hasMethodCode(out, "113101"));
        assertEquals("YES", out.getString(Tag.BurnedInAnnotation), "原本のまま");
        byte[] untouched = new byte[ROWS * COLS];
        java.util.Arrays.fill(untouched, (byte) 200);
        assertArrayEquals(untouched, frameOf(out.getBytes(Tag.PixelData), 0), "1 画素も変えていない");
    }

    /**
     * 🔴 <b>利用者が踏んだそのもの</b>（2026-09-24）。
     *
     * <p>XA は JPEG 圧縮が標準で、以前はそれだけで焼き込みが無条件にスキップされていた
     * ——マスクを登録しても全フレームが未マスクのまま出力され、警告も出なかった。
     */
    @Test
    void 圧縮画像でも伸長して全フレーム塗る(@TempDir Path dir) throws Exception {
        PixelCodec c = new PixelCodec(new DicomProperties());
        Assumptions.assumeTrue(c.available(), "OpenCV ネイティブが無い環境: " + c.unavailableReason());

        Path src = TestDicomFiles.writeJpegBaseline(dir.resolve("in.dcm"), STUDY, SERIES, SOP, FRAMES, 200);
        AnonymizeService.Result r = run(dir, src, maskOnFrames(List.of()));

        assertEquals(1, r.burnedInstances(), "圧縮でも塗れる");
        assertEquals(0, r.notBurnedInstances());

        Attributes out = readOutput(dir);
        assertTrue(hasMethodCode(out, "113101"));
        assertEquals("NO", out.getString(Tag.BurnedInAnnotation));

        byte[] px = out.getBytes(Tag.PixelData);
        assertEquals(ROWS * COLS * FRAMES, px.length, "伸長後は素の画素が並ぶ");
        for (int f = 0; f < FRAMES; f++) {
            assertTrue(isBlank(px, f), "フレーム " + f + " が塗られている");
        }
        // 塗っていない領域は元の濃度のまま（JPEG の丸めぶんだけ許容）。
        byte[] f0 = frameOf(px, 0);
        int v = f0[ROWS * COLS - 1] & 0xFF;
        assertTrue(Math.abs(v - 200) <= 4, "マスク外は元の濃度: " + v);
    }

    // ------------------------------------------------------------------------
    // 組み立て
    // ------------------------------------------------------------------------

    /** マスク領域（画像の左上 8x8）。全フレーム共通の焼き込み文字を模す。 */
    private static AnonymizeMaskStore.SeriesMask maskOnFrames(List<Integer> frames) {
        AnonymizeMaskStore.MaskPolygon p = new AnonymizeMaskStore.MaskPolygon(
                new double[] { 0, 8, 8, 0 }, new double[] { 0, 0, 8, 8 }, List.of(SOP), frames);
        return new AnonymizeMaskStore.SeriesMask(SERIES, List.of(), List.of(), List.of(p));
    }

    @SuppressWarnings("unchecked")
    private static AnonymizeService.Result run(Path dir, Path src, AnonymizeMaskStore.SeriesMask mask)
            throws IOException {
        AnonymizeMaskStore store = new AnonymizeMaskStore();
        if (mask != null) {
            store.put(mask);
        }
        DicomInstance inst = new DicomInstance(SOP);
        inst.setUri(src.toUri().toString());
        inst.setSeriesInstanceUid(SERIES);
        inst.setStudyInstanceUid(STUDY);
        inst.setPatientId("P1");
        DicomInstanceRepository repo = Mockito.mock(DicomInstanceRepository.class);
        Mockito.when(repo.findByStudyInstanceUid(STUDY)).thenReturn(List.of(inst));
        ObjectProvider<com.vis.graphynext.dicom.web.WebDicomDataService> web =
                Mockito.mock(ObjectProvider.class);
        Mockito.when(web.getIfAvailable()).thenReturn(null);

        AnonymizeService service = new AnonymizeService(repo, store, web, new PixelCodec(new DicomProperties()));
        AnonymizeConfig cfg = new AnonymizeConfig();
        cfg.addOption(AnonymizeConfig.Option.CleanPixelData);
        cfg.setBurnDilatePx(0); // 膨張させない（塗った範囲を画素単位で確かめたいので）
        return service.anonymizeToFolder(List.of(STUDY), cfg, true, dir.resolve("out").toString());
    }

    /** 出力は「匿名化後の UID 階層」に置かれるので、拡張子で拾う。 */
    private static Attributes readOutput(Path dir) throws IOException {
        Path out;
        try (var s = Files.walk(dir.resolve("out"))) {
            out = s.filter(p -> p.toString().endsWith(".dcm")).findFirst().orElseThrow();
        }
        try (DicomInputStream in = new DicomInputStream(out.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            return in.readDataset(-1, -1);
        }
    }

    private static byte[] frameOf(byte[] px, int frame) {
        int size = ROWS * COLS;
        return java.util.Arrays.copyOfRange(px, frame * size, (frame + 1) * size);
    }

    /** そのフレームのマスク領域（左上 8x8）が 0 で潰れているか。 */
    private static boolean isBlank(byte[] px, int frame) {
        byte[] f = frameOf(px, frame);
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                if (f[y * COLS + x] != 0) {
                    return false;
                }
            }
        }
        return true;
    }

    private static boolean hasMethodCode(Attributes ds, String code) {
        Sequence sq = ds.getSequence(Tag.DeidentificationMethodCodeSequence);
        if (sq == null) {
            return false;
        }
        for (Attributes item : sq) {
            if (code.equals(item.getString(Tag.CodeValue))) {
                return true;
            }
        }
        return false;
    }
}
