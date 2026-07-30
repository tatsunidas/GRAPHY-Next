/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.video;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.video.VideoRenderService.Payload;
import com.vis.graphynext.nondicom.FfmpegLocator;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link VideoRenderService}（P4: 配信時の remux / 再エンコード）のテスト。
 *
 * <p>実際に変換する系は ffmpeg が要るので、無い環境では {@link Assumptions} で skip する
 * （判定ロジックとコマンド組み立ては ffmpeg 不要なので常に走る）。
 */
class VideoRenderServiceTest {

    /** MPEG2 MP@ML。中身は MPEG-2 video の基本ストリーム（コンテナ無し）＝ブラウザ非対応。 */
    private static final String MPEG2_MP_ML = "1.2.840.10008.1.2.4.100";
    /** MPEG-4 AVC/H.264 High@4.1。正規 DICOM では Annex-B の基本ストリームが入る。 */
    private static final String H264_HIGH_41 = "1.2.840.10008.1.2.4.102";

    private static boolean ffmpegPresent;

    @BeforeAll
    static void detectFfmpeg() {
        ffmpegPresent = VideoRenderService.ffmpegAvailable("ffmpeg");
    }

    /** payload を 1 フラグメントに入れた encapsulated video DICOM を書く（取込経路と同形式）。 */
    private static String writeVideoDicom(Path out, String tsuid, byte[] payload) throws IOException {
        Attributes attrs = new Attributes();
        String sop = UIDUtils.createUID();
        attrs.setString(Tag.SOPClassUID, VR.UI, UID.VideoPhotographicImageStorage);
        attrs.setString(Tag.SOPInstanceUID, VR.UI, sop);
        attrs.setString(Tag.StudyInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        attrs.setString(Tag.Modality, VR.CS, "XC");
        attrs.setInt(Tag.Rows, VR.US, 240);
        attrs.setInt(Tag.Columns, VR.US, 320);
        attrs.setInt(Tag.NumberOfFrames, VR.IS, 15);
        attrs.setDouble(Tag.FrameTime, VR.DS, 1000.0 / 15);

        boolean odd = (payload.length & 1) != 0;
        int itemLen = odd ? payload.length + 1 : payload.length;
        Attributes fmi = attrs.createFileMetaInformation(tsuid);
        try (DicomOutputStream dos = new DicomOutputStream(out.toFile())) {
            dos.writeDataset(fmi, attrs);
            dos.writeHeader(Tag.PixelData, VR.OB, -1);      // undefined length = encapsulated
            dos.writeHeader(Tag.Item, null, 0);             // 空 Basic Offset Table
            dos.writeHeader(Tag.Item, null, itemLen);
            dos.write(payload);
            if (odd) {
                dos.write(0);
            }
            dos.writeHeader(Tag.SequenceDelimitationItem, null, 0);
        }
        return sop;
    }

    /**
     * ffmpeg で検証用の映像を作る（形式は引数で指定）。
     *
     * <p>⚠ 生の MPEG-2 映像は **muxer 名が {@code mpeg2video}／demuxer 名が {@code mpegvideo}** で異なる。
     * 生成（出力）側で {@code -f mpegvideo} を指定すると "not a suitable output format" になる。
     */
    private static byte[] synthesize(Path dir, String name, List<String> codecArgs) throws IOException {
        Path out = dir.resolve(name);
        List<String> cmd = new java.util.ArrayList<>(List.of(
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1", "-an"));
        cmd.addAll(codecArgs);
        cmd.add(out.toString());
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            p.getInputStream().readAllBytes();
            assertTrue(p.waitFor(120, TimeUnit.SECONDS), "ffmpeg がタイムアウトした");
            assertEquals(0, p.exitValue(), "検証データの生成に失敗した: " + String.join(" ", cmd));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException(e);
        }
        return Files.readAllBytes(out);
    }

    private static VideoRenderService service(Path storageDir, String ffmpegPath) {
        DicomProperties props = new DicomProperties();
        props.setStorageDir(storageDir.toString());
        return new VideoRenderService(new FfmpegLocator(ffmpegPath, ""), props);
    }

    private static boolean isMp4(Path f) throws IOException {
        byte[] head = Files.readAllBytes(f);
        return head.length > 8 && head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p';
    }

    // ── ペイロード判定（ffmpeg 不要な純ロジック） ───────────────────────────────

    @Test
    void sniff_detectsMp4ByFtypBox(@TempDir Path dir) throws IOException {
        Path f = dir.resolve("a.bin");
        Files.write(f, new byte[] {0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'});
        assertEquals(Payload.MP4, VideoRenderService.sniff(f));
    }

    @Test
    void sniff_detectsMpeg2SequenceHeader(@TempDir Path dir) throws IOException {
        Path f = dir.resolve("b.bin");
        Files.write(f, new byte[] {0, 0, 1, (byte) 0xB3, 0x14, 0x00, (byte) 0xF0, 0x13});
        assertEquals(Payload.MPEG2_ES, VideoRenderService.sniff(f));
    }

    @Test
    void sniff_detectsH264AnnexBSps(@TempDir Path dir) throws IOException {
        Path f = dir.resolve("c.bin");
        // 00 00 00 01 + 0x67（nal_ref_idc=3, nal_unit_type=7=SPS）
        Files.write(f, new byte[] {0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28});
        assertEquals(Payload.H264_ES, VideoRenderService.sniff(f));
    }

    @Test
    void sniff_detectsHevcAnnexBSps(@TempDir Path dir) throws IOException {
        Path f = dir.resolve("d.bin");
        // 00 00 00 01 + 0x42（nal_unit_type=33=SPS_NUT）
        Files.write(f, new byte[] {0, 0, 0, 1, 0x42, 0x01, 0x01, 0x01});
        assertEquals(Payload.HEVC_ES, VideoRenderService.sniff(f));
    }

    @Test
    void sniff_unknownForGarbage(@TempDir Path dir) throws IOException {
        Path f = dir.resolve("e.bin");
        Files.write(f, "not a video at all, just text".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        assertEquals(Payload.UNKNOWN, VideoRenderService.sniff(f));
    }

    // ── コマンド組み立て（ffmpeg 不要） ─────────────────────────────────────────

    @Test
    void buildCommand_remuxesElementaryStreamsWithoutReencoding() {
        List<String> h264 = VideoRenderService.buildCommand("ffmpeg", Payload.H264_ES, Path.of("in"), Path.of("out"), 15);
        assertTrue(h264.containsAll(List.of("-f", "h264")), "入力形式を明示する: " + h264);
        assertTrue(h264.containsAll(List.of("-c:v", "copy")), "再圧縮しない: " + h264);
        assertTrue(h264.containsAll(List.of("-movflags", "+faststart")), "moov を先頭に: " + h264);
        assertTrue(h264.contains("-an"), "音声は落とす: " + h264);

        List<String> hevc = VideoRenderService.buildCommand("ffmpeg", Payload.HEVC_ES, Path.of("in"), Path.of("out"), 15);
        assertTrue(hevc.containsAll(List.of("-f", "hevc")) && hevc.containsAll(List.of("-c:v", "copy")));
    }

    @Test
    void buildCommand_reencodesMpeg2ToH264High41() {
        List<String> cmd = VideoRenderService.buildCommand("ffmpeg", Payload.MPEG2_ES, Path.of("in"), Path.of("out"), 15);
        assertTrue(cmd.containsAll(List.of("-f", "mpegvideo")), "入力形式を明示する: " + cmd);
        assertTrue(cmd.containsAll(List.of("-c:v", "libx264")), "H.264 へ再エンコード: " + cmd);
        assertTrue(cmd.containsAll(List.of("-profile:v", "high")) && cmd.containsAll(List.of("-level:v", "4.1")));
        // 取込側（VideoConverter）と同じフレーム順序保証。
        assertTrue(cmd.containsAll(List.of("-bf", "0")), "B-frame 無効: " + cmd);
    }

    @Test
    void buildCommand_passesFrameRateAsInputOptionForElementaryStreams() {
        // 🚨 基本ストリームには時間情報が無い。-r を入力側に渡さないと raw demuxer が 25fps を仮定し、
        // さらに先頭フレームの PTS が 1 フレーム分ずれて「フレーム f の統計が f−1 の値になる」
        // （2026-07-30 の実機検証で発覚。実測 duration 2.067s / 先頭 PTS 0.066）。
        List<String> cmd = VideoRenderService.buildCommand("ffmpeg", Payload.MPEG2_ES, Path.of("in"), Path.of("out"), 15);
        int rIdx = cmd.indexOf("-r");
        int iIdx = cmd.indexOf("-i");
        assertTrue(rIdx >= 0, "-r を渡す: " + cmd);
        assertEquals("15", cmd.get(rIdx + 1));
        assertTrue(rIdx < iIdx, "-r は入力オプションなので -i より前: " + cmd);

        // MP4 はコンテナに時間情報があるので渡さない（そもそも変換経路に来ない）。
        List<String> mp4 = VideoRenderService.buildCommand("ffmpeg", Payload.MP4, Path.of("in"), Path.of("out"), 15);
        assertTrue(!mp4.contains("-r"), "MP4 には -r を渡さない: " + mp4);

        // fps 不明（0）なら渡さない（誤った時間情報を押し付けない）。
        List<String> unknown = VideoRenderService.buildCommand("ffmpeg", Payload.MPEG2_ES, Path.of("in"), Path.of("out"), 0);
        assertTrue(!unknown.contains("-r"), "fps 不明なら -r 無し: " + unknown);
    }

    @Test
    void formatFps_roundsFrameTimeDerivedValuesToIntegers() {
        // FrameTime 66.666… から求めた fps は 14.999999999999998 になる。ffmpeg には 15 と渡したい。
        assertEquals("15", VideoRenderService.formatFps(14.999999999999998));
        assertEquals("30", VideoRenderService.formatFps(30.0));
        assertEquals("29.970000", VideoRenderService.formatFps(29.97));
    }

    @Test
    void cacheName_sanitizesPathSeparators() {
        assertEquals("1.2.3", VideoRenderService.cacheName("1.2.3"));
        assertEquals("_.._etc_passwd", VideoRenderService.cacheName("/../etc/passwd"));
    }

    // ── 配信（実 ffmpeg が要る系） ────────────────────────────────────────────

    @Test
    void ensureRendered_servesMp4PayloadAsIsWithoutFfmpeg(@TempDir Path dir) throws IOException {
        // MP4 ペイロードは ffmpeg 不在でも配信できる（主経路）。存在しない ffmpeg を指定して確かめる。
        Assumptions.assumeTrue(ffmpegPresent, "ffmpeg が無い環境ではペイロードを合成できないため skip");
        byte[] mp4 = synthesize(dir, "src.mp4",
                List.of("-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart"));
        Path dcm = dir.resolve("h264.dcm");
        String sop = writeVideoDicom(dcm, H264_HIGH_41, mp4);

        Path storage = dir.resolve("storage");
        Path out = service(storage, dir.resolve("no-such-ffmpeg").toString()).ensureRendered(dcm, sop);

        assertTrue(isMp4(out), "MP4 として配信される");
        assertEquals(mp4.length, Files.size(out), "無変換なのでバイト数が一致する");
    }

    @Test
    void ensureRendered_transcodesMpeg2ElementaryStreamToPlayableMp4(@TempDir Path dir) throws IOException {
        Assumptions.assumeTrue(ffmpegPresent, "ffmpeg が無い環境では skip");
        // 正規 DICOM の MPEG2 と同じ「コンテナ無しの基本ストリーム」を作る。
        byte[] es = synthesize(dir, "src.m2v", List.of("-c:v", "mpeg2video", "-f", "mpeg2video"));
        Path dcm = dir.resolve("mpeg2.dcm");
        String sop = writeVideoDicom(dcm, MPEG2_MP_ML, es);

        Path storage = dir.resolve("storage");
        Path out = service(storage, "ffmpeg").ensureRendered(dcm, sop);

        assertTrue(isMp4(out), "MPEG2 でも MP4（ftyp）になって配信される");
        assertTrue(Files.size(out) > 0);
        assertNotEquals(es.length, Files.size(out), "再エンコードされている（そのままではない）");
    }

    @Test
    void ensureRendered_remuxesH264ElementaryStreamToMp4(@TempDir Path dir) throws IOException {
        Assumptions.assumeTrue(ffmpegPresent, "ffmpeg が無い環境では skip");
        // 転送構文は H.264 だが中身は Annex-B の基本ストリーム（正規 DICOM のパターン）。
        // 転送構文だけ見て「無変換で配信できる」と判断すると再生できない MP4 未満のバイト列を返してしまう。
        byte[] es = synthesize(dir, "src.h264", List.of("-c:v", "libx264", "-bsf:v", "h264_mp4toannexb", "-f", "h264"));
        Path dcm = dir.resolve("h264es.dcm");
        String sop = writeVideoDicom(dcm, H264_HIGH_41, es);

        Path storage = dir.resolve("storage");
        Path out = service(storage, "ffmpeg").ensureRendered(dcm, sop);

        assertTrue(isMp4(out), "remux されて MP4（ftyp）になる");
    }

    @Test
    void ensureRendered_reusesCacheOnSecondCall(@TempDir Path dir) throws IOException {
        Assumptions.assumeTrue(ffmpegPresent, "ffmpeg が無い環境では skip");
        byte[] es = synthesize(dir, "src.m2v", List.of("-c:v", "mpeg2video", "-f", "mpeg2video"));
        Path dcm = dir.resolve("mpeg2.dcm");
        String sop = writeVideoDicom(dcm, MPEG2_MP_ML, es);
        VideoRenderService svc = service(dir.resolve("storage"), "ffmpeg");

        Path first = svc.ensureRendered(dcm, sop);
        java.nio.file.attribute.FileTime t1 = Files.getLastModifiedTime(first);
        Path second = svc.ensureRendered(dcm, sop);

        assertEquals(first, second);
        assertEquals(t1, Files.getLastModifiedTime(second), "2 回目は変換せずキャッシュを返す");
    }

    @Test
    void ensureRendered_regeneratesWhenSourceIsNewerThanCache(@TempDir Path dir) throws IOException {
        Assumptions.assumeTrue(ffmpegPresent, "ffmpeg が無い環境では skip");
        byte[] es = synthesize(dir, "src.m2v", List.of("-c:v", "mpeg2video", "-f", "mpeg2video"));
        Path dcm = dir.resolve("mpeg2.dcm");
        String sop = writeVideoDicom(dcm, MPEG2_MP_ML, es);
        VideoRenderService svc = service(dir.resolve("storage"), "ffmpeg");

        Path first = svc.ensureRendered(dcm, sop);
        java.nio.file.attribute.FileTime t1 = Files.getLastModifiedTime(first);
        // 同じ SOP を削除 → 再取込した状況（automator の reset は実ファイルを消すがキャッシュは消さない）。
        Files.setLastModifiedTime(dcm, java.nio.file.attribute.FileTime.fromMillis(t1.toMillis() + 5_000));

        Path again = svc.ensureRendered(dcm, sop);
        assertTrue(Files.getLastModifiedTime(again).toMillis() >= t1.toMillis() + 1,
                "元が新しくなったら作り直す（古い変換結果を配信し続けない）");
    }

    @Test
    void ensureRendered_throwsWhenFfmpegMissingAndTranscodeNeeded(@TempDir Path dir) throws IOException {
        Assumptions.assumeTrue(ffmpegPresent, "ffmpeg が無い環境ではペイロードを合成できないため skip");
        byte[] es = synthesize(dir, "src.m2v", List.of("-c:v", "mpeg2video", "-f", "mpeg2video"));
        Path dcm = dir.resolve("mpeg2.dcm");
        String sop = writeVideoDicom(dcm, MPEG2_MP_ML, es);
        VideoRenderService svc = service(dir.resolve("storage"), dir.resolve("no-such-ffmpeg").toString());

        assertThrows(VideoRenderService.TranscodeUnavailableException.class, () -> svc.ensureRendered(dcm, sop));
    }
}
