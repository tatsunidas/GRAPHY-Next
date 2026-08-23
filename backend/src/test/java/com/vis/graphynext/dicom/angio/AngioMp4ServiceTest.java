/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * MP4 書き出し（§14.3 / A10）の、ffmpeg を起動しないで確かめられる部分。
 *
 * <p>ffmpeg を実際に回すのは実機スパイク側。ここで守るのは
 * <b>外から来た ZIP をどう展開するか</b>（zip-slip・並び順・上限）と<b>コマンドの形</b>。
 */
class AngioMp4ServiceTest {

    private static byte[] zipOf(String... names) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(bos)) {
            for (String n : names) {
                zos.putNextEntry(new ZipEntry(n));
                zos.write(("data:" + n).getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();
            }
        }
        return bos.toByteArray();
    }

    @Test
    void 連番へ採番し直す() throws IOException {
        Path dir = Files.createTempDirectory("mp4-test-");
        int n = AngioMp4Service.extractPngs(zipOf("a-0002.png", "a-0001.png", "a-0003.png"), dir);
        assertEquals(3, n);
        assertTrue(Files.exists(dir.resolve("f-00001.png")));
        assertTrue(Files.exists(dir.resolve("f-00003.png")));
        // 🚨 名前の昇順がフレーム順。ここが崩れると**動画のコマ順が入れ替わる**（絵は出るので気づけない）。
        assertEquals("data:a-0001.png", Files.readString(dir.resolve("f-00001.png")));
        assertEquals("data:a-0002.png", Files.readString(dir.resolve("f-00002.png")));
        assertEquals("data:a-0003.png", Files.readString(dir.resolve("f-00003.png")));
    }

    @Test
    void エントリ名を使わない_zip_slip() throws IOException {
        // 🔴 受け取るのは外から来た ZIP。名前をそのまま結合すると `../` で任意の場所に書ける。
        //     名前は並べ替えにしか使わず、書き出す名前はこちらが決める。
        Path dir = Files.createTempDirectory("mp4-test-");
        int n = AngioMp4Service.extractPngs(zipOf("../../evil.png", "sub/dir/x.png"), dir);
        assertEquals(2, n);
        assertTrue(Files.exists(dir.resolve("f-00001.png")));
        assertTrue(Files.exists(dir.resolve("f-00002.png")));
        assertFalse(Files.exists(dir.getParent().getParent().resolve("evil.png")), "親へ書き出していない");
        try (var walk = Files.walk(dir)) {
            assertEquals(
                    2,
                    walk.filter(Files::isRegularFile).count(),
                    "展開したのは 2 ファイルだけ（サブディレクトリを作らない）");
        }
    }

    @Test
    void PNG以外は無視する() throws IOException {
        Path dir = Files.createTempDirectory("mp4-test-");
        int n = AngioMp4Service.extractPngs(zipOf("readme.txt", "a-0001.png", "notes.json"), dir);
        assertEquals(1, n);
    }

    @Test
    void 空のZIPは失敗させる() throws IOException {
        Path dir = Files.createTempDirectory("mp4-test-");
        assertEquals(0, AngioMp4Service.extractPngs(zipOf("readme.txt"), dir));
    }

    @Test
    void フレーム数の上限を超えたら止める() throws IOException {
        Path dir = Files.createTempDirectory("mp4-test-");
        String[] names = new String[AngioMp4Service.MAX_FRAMES + 1];
        for (int i = 0; i < names.length; i++) {
            names[i] = String.format("f-%05d.png", i);
        }
        byte[] zip = zipOf(names);
        IOException e = assertThrows(IOException.class, () -> AngioMp4Service.extractPngs(zip, dir));
        assertTrue(e.getMessage().contains("上限"), e.getMessage());
    }

    @Test
    void コマンドは取込側と同じ約束にする() {
        List<String> cmd = AngioMp4Service.encodeCommand("/usr/bin/ffmpeg", "/tmp/f-%05d.png", 15, "/tmp/out.mp4");
        assertTrue(cmd.contains("libx264"), cmd.toString());
        // decode order = presentation order（旧 GRAPHY のコマ順バグ対策。VideoConverter と揃える）
        assertEquals("0", cmd.get(cmd.indexOf("-bf") + 1));
        assertEquals("yuv420p", cmd.get(cmd.indexOf("-pix_fmt") + 1));
        assertEquals("15", cmd.get(cmd.indexOf("-framerate") + 1));
        // 🔴 yuv420p は幅・高さが偶数でないとエンコードできない。奇数サイズで突然失敗しないように。
        assertTrue(cmd.get(cmd.indexOf("-vf") + 1).contains("trunc(iw/2)*2"), cmd.toString());
        assertTrue(cmd.indexOf("-i") < cmd.indexOf("-c:v"), "入力は出力オプションより前");
    }

    @Test
    void 小数のフレームレートを潰さない() {
        // 29.97fps や 14.985fps は実在する（FrameTime から出す）。整数へ丸めると尺がずれる。
        assertEquals("15", AngioMp4Service.trimNumber(15.0));
        assertEquals("29.970", AngioMp4Service.trimNumber(29.97));
    }
}
