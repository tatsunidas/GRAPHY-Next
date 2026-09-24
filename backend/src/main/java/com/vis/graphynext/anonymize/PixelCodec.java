/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.Dcm4cheHome;
import com.vis.graphynext.dicom.DicomProperties;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.imageio.codec.Decompressor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

/**
 * 圧縮 PixelData の伸長（匿名化の焼き込み専用）。
 *
 * <h2>なぜ要るのか</h2>
 * 焼き込み除去（Clean Pixel Data）の主な対象は <b>XA と US ——
 * どちらも JPEG 圧縮が標準</b>で、非圧縮の方が例外に近い。伸長できないと、
 * 「マスクを登録したのに 1 画素も塗られないまま出力される」ことになる
 * （2026-09-24 に利用者が踏んだ。実測で JPEG Baseline の 96 フレーム全部が未マスク）。
 *
 * <h2>🔴 使えないなら「使えない」と答える。推測で進まない</h2>
 * 実体は JNI（OpenCV）で、3 つ揃って初めて動く。1 つでも欠けたら {@link #available()} が
 * false を返し、呼び出し元は<b>書き出す前に処理を止める</b>——塗れないまま出力するくらいなら
 * 機能を止める、という {@code AnonymizeController} と同じ判断基準。
 *
 * <ol>
 *   <li>{@code dcm4che-imageio-opencv} がクラスパスにある（pom.xml）</li>
 *   <li>ネイティブ {@code libopencv_java} を読める（{@link #loadNative()}）</li>
 *   <li>JVM に {@code --add-opens} が 2 つ渡っている（{@link #modulesOpened()}）</li>
 * </ol>
 *
 * <p>⚠ <b>3 を先に確かめるのが必須。</b> {@code org.dcm4che3.opencv.StreamSegment} は
 * {@code FileImageInputStream.raf} と {@code RandomAccessFile.path} へリフレクションで触る。
 * {@code java.desktop/javax.imageio.stream} だけ開いて {@code java.base/java.io} を開き忘れると、
 * 例外では済まず <b>JVM が SIGSEGV で落ちる</b>（実測）。backend ごと巻き込まれるので、
 * ネイティブに触る前に <b>純 Java の {@link Module#isOpen} で判定する</b>。
 * フラグは {@code desktop/main.js} の {@code jvmArgs} が渡す。
 */
@Component
public class PixelCodec {

    private static final Logger log = LoggerFactory.getLogger(PixelCodec.class);

    /** 画素がそのまま並んでいる（伸長が要らない）転送構文。 */
    private static final Set<String> UNCOMPRESSED = Set.of(
            UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian, UID.ExplicitVRBigEndian);

    private final DicomProperties props;

    /** 判定は 1 回だけ（ネイティブの読み込みは再試行しても結果が変わらない）。 */
    private Boolean ready;
    private String reason = "";

    public PixelCodec(DicomProperties props) {
        this.props = props;
    }

    /** 伸長が要らない転送構文か。 */
    public static boolean isUncompressed(String tsuid) {
        return tsuid != null && UNCOMPRESSED.contains(tsuid);
    }

    /** 圧縮画素を伸長できる状態か。false なら理由は {@link #unavailableReason()}。 */
    public synchronized boolean available() {
        if (ready == null) {
            ready = detect();
            if (ready) {
                log.info("圧縮画素の伸長: 利用可能（匿名化の焼き込みが圧縮画像にも効きます）");
            } else {
                log.warn("圧縮画素の伸長: 利用できません（{}）。圧縮画像の焼き込みは実行前に中止されます", reason);
            }
        }
        return ready;
    }

    /** 利用者に見せる理由（{@link #available()} が false のとき）。 */
    public synchronized String unavailableReason() {
        available();
        return reason;
    }

    private boolean detect() {
        if (!modulesOpened()) {
            // 🔴 ここで止めないと JVM ごと落ちる。フラグが無い配布物は「使えない」で正しい。
            reason = "JVM に --add-opens java.base/java.io と java.desktop/javax.imageio.stream が"
                    + "渡されていません（desktop/main.js の jvmArgs）";
            return false;
        }
        if (!classPresent("org.dcm4che3.opencv.NativeImageReader")) {
            reason = "dcm4che-imageio-opencv がクラスパスにありません";
            return false;
        }
        Path lib = findNative();
        if (lib == null) {
            reason = "ネイティブライブラリ " + Dcm4cheHome.openCvLibFileName() + " が同梱 dcm4che の lib/"
                    + Dcm4cheHome.nativeLibDirName() + " に見つかりません";
            return false;
        }
        try {
            loadNative(lib);
        } catch (Throwable t) {
            reason = "ネイティブライブラリを読み込めません: " + lib + " (" + t.getMessage() + ")";
            return false;
        }
        return true;
    }

    /**
     * {@code StreamSegment} のリフレクションが通るか。
     *
     * <p>backend は fat jar（＝名前なしモジュール）で動くので、dcm4che 側も同じ名前なしモジュールに居る。
     * ここで自分のモジュールに対して開いているかを見れば、dcm4che 側の可否とそのまま一致する。
     */
    static boolean modulesOpened() {
        Module me = PixelCodec.class.getModule();
        return java.io.RandomAccessFile.class.getModule().isOpen("java.io", me)
                && javax.imageio.stream.FileImageInputStream.class.getModule()
                        .isOpen("javax.imageio.stream", me);
    }

    private static boolean classPresent(String name) {
        try {
            Class.forName(name, false, PixelCodec.class.getClassLoader());
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 同梱 dcm4che の {@code lib/<os-arch>/} からネイティブを探す。 */
    private Path findNative() {
        String dir = Dcm4cheHome.nativeLibDirName();
        String file = Dcm4cheHome.openCvLibFileName();
        for (Path base : Dcm4cheHome.candidateDirs(props.getDcm4cheHome())) {
            Path p = base.resolve("lib").resolve(dir).resolve(file);
            if (Files.isRegularFile(p)) {
                return p;
            }
        }
        return null;
    }

    /**
     * 絶対パスで読み込む。
     *
     * <p>⚠ このあと weasis のローダが {@code System.loadLibrary("opencv_java")} を試みて失敗し、
     * <b>「Cannot load OpenCV native library: no opencv_java in java.library.path」を 1 行出すが、
     * 伸長は正常に動く</b>。JNI のネイティブメソッドは「そのクラスを定義したクラスローダが
     * 読み込み済みのライブラリ」から解決されるため、絶対パスで先に読んでおけば結び付く。
     *
     * <p>{@code -Djava.library.path} を使わないのは、<b>探索規則を Java 側（{@link Dcm4cheHome}）に
     * 残したいから</b>。パスを JVM 引数で渡すと desktop/main.js に 2 つ目の探索規則ができ、
     * 開発機（{@code ~/dcm4che-*}）と配布物（{@code resources/dcm4che}）で食い違う余地が生まれる。
     */
    private static void loadNative(Path lib) {
        System.load(lib.toAbsolutePath().toString());
    }

    /**
     * 圧縮 PixelData をその場で伸長する。
     *
     * <p>🔴 <b>データセットは {@code IncludeBulkData.URI} で読んであること。</b>
     * {@link Decompressor} は PixelData のフラグメントが {@code BulkData}（＝元ファイルへの参照）で
     * あることを要求する。{@code IncludeBulkData.YES} で読むと byte[] になっていて
     * {@code ClassCastException} になる。
     *
     * @return 伸長後の画素。できなければ null（呼び出し元は塗らない）
     */
    public byte[] decompress(Attributes ds, String tsuid) {
        if (!available()) {
            return null;
        }
        Decompressor d = null;
        try {
            d = new Decompressor(ds, tsuid);
            if (!d.decompress()) {
                return null;
            }
            // decompress() が仕込むのは遅延値。ここで実際にデコードが走る（全フレーム）。
            return ds.getBytes(Tag.PixelData);
        } catch (Exception e) {
            log.warn("圧縮画素の伸長に失敗しました (ts={}): {}", tsuid, e.toString());
            return null;
        } finally {
            if (d != null) {
                // 静的な Decompressor.decompress() は ImageReader を解放しない。件数が多いと効く。
                d.dispose();
            }
        }
    }
}
