/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.DicomScpServer;
import com.vis.graphynext.dicom.store.DicomStoreScu.TsPolicy;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.PDVInputStream;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCStoreSCP;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 送信時の転送構文の指定（STORED／EXPLICIT_LE／IMPLICIT_LE）。指定した構文だけを提示し、
 * 受け入れられなければ保存どおりで送り直さず失敗に数える。
 */
class DicomStoreScuTsPolicyTest {

    private static final String SOP_A = "1.2.826.0.1.3680043.10.1338.7201";
    private static final String SOP_B = "1.2.826.0.1.3680043.10.1338.7202";

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    /** 受け付ける転送構文を絞った SCP。受けたファイルは dir に「SOP.dcm」で書く。 */
    private static DicomScpServer scp(int port, Path dir, String... acceptTs) throws Exception {
        DicomScpServer server = new DicomScpServer("RCVSCP", "127.0.0.1", port);
        server.addService(new BasicCStoreSCP("*") {
            @Override
            protected void store(Association as, PresentationContext pc, Attributes rq, PDVInputStream data, Attributes rsp)
                    throws IOException {
                String iuid = rq.getString(Tag.AffectedSOPInstanceUID);
                Attributes fmi = as.createFileMetaInformation(iuid, rq.getString(Tag.AffectedSOPClassUID), pc.getTransferSyntax());
                try (DicomOutputStream out = new DicomOutputStream(dir.resolve(iuid + ".dcm").toFile())) {
                    out.writeFileMetaInformation(fmi);
                    data.copyTo(out);
                }
            }
        }, new TransferCapability(null, "*", TransferCapability.Role.SCP, acceptTs));
        server.start();
        return server;
    }

    /** 受信ファイルの画素（非圧縮）。 */
    private static byte[] pixels(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDataset().getBytes(Tag.PixelData);
        }
    }

    private static String patientId(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDataset().getString(Tag.PatientID);
        }
    }

    private static Path stored(Path dir, String sop, String ts) throws IOException {
        Path f = dir.resolve(sop + ".src.dcm");
        // 先頭の FMI は常に Explicit VR LE。本体の転送構文は FMI の指定で切り替わる（Implicit も書ける）
        Attributes ds = CompressedFixtures.ct(sop, "TSPID");
        try (DicomOutputStream dos = new DicomOutputStream(f.toFile())) {
            dos.writeDataset(ds.createFileMetaInformation(ts), ds);
        }
        return f;
    }

    private static byte[] wantPixels() throws IOException {
        return CompressedFixtures.ct(SOP_A, "TSPID").getBytes(Tag.PixelData);
    }

    @Test
    void 保存がImplicitでもExplicit指定なら_Explicitで届き_画素が一致(@TempDir Path dir) throws Exception {
        Path file = stored(dir, SOP_A, UID.ImplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian, UID.ImplicitVRLittleEndian);
        try {
            DicomStoreScu.StoreResult r = new DicomStoreScu().store("127.0.0.1", port, "RCVSCP", "SENDER", file, null,
                    TsPolicy.EXPLICIT_LE);
            assertTrue(r.success(), r.message());
        } finally {
            server.stop();
        }
        Path got = rx.resolve(SOP_A + ".dcm");
        assertEquals(UID.ExplicitVRLittleEndian, CompressedFixtures.tsOf(got));
        assertArrayEquals(wantPixels(), pixels(got));
        assertEquals("TSPID", patientId(got));
    }

    @Test
    void 保存がExplicitでもImplicit指定なら_Implicitで届き_画素が一致(@TempDir Path dir) throws Exception {
        Path file = stored(dir, SOP_A, UID.ExplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian, UID.ImplicitVRLittleEndian);
        try {
            assertTrue(new DicomStoreScu().store("127.0.0.1", port, "RCVSCP", "SENDER", file, null, TsPolicy.IMPLICIT_LE).success());
        } finally {
            server.stop();
        }
        Path got = rx.resolve(SOP_A + ".dcm");
        assertEquals(UID.ImplicitVRLittleEndian, CompressedFixtures.tsOf(got));
        assertArrayEquals(wantPixels(), pixels(got));
        assertEquals("TSPID", patientId(got));
    }

    @Test
    void 対照_STORED指定なら保存の構文のまま届く(@TempDir Path dir) throws Exception {
        Path file = stored(dir, SOP_A, UID.ImplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian, UID.ImplicitVRLittleEndian);
        try {
            assertTrue(new DicomStoreScu().store("127.0.0.1", port, "RCVSCP", "SENDER", file, null, TsPolicy.STORED).success());
        } finally {
            server.stop();
        }
        assertEquals(UID.ImplicitVRLittleEndian, CompressedFixtures.tsOf(rx.resolve(SOP_A + ".dcm")),
                "指定が無ければ変換されない（指定した場合との差が出ること）");
    }

    @Test
    void 相手が指定の構文を受けなければ_保存どおりで送り直さず失敗(@TempDir Path dir) throws Exception {
        Path file = stored(dir, SOP_A, UID.ImplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ImplicitVRLittleEndian); // Explicit は受けない（保存の Implicit は受ける）
        try {
            DicomStoreScu.StoreResult r = new DicomStoreScu().store("127.0.0.1", port, "RCVSCP", "SENDER", file, null,
                    TsPolicy.EXPLICIT_LE);
            assertFalse(r.success());
            assertTrue(r.message().contains("指定の転送構文"), r.message());
        } finally {
            server.stop();
        }
        assertFalse(Files.exists(rx.resolve(SOP_A + ".dcm")), "保存どおりで送り直していない");
    }

    @Test
    void まとめ送信_構文が混ざっていても全件が指定の構文で届く(@TempDir Path dir) throws Exception {
        Path a = stored(dir, SOP_A, UID.ImplicitVRLittleEndian);
        Path b = stored(dir, SOP_B, UID.ExplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian, UID.ImplicitVRLittleEndian);
        try {
            DicomStoreScu.BatchResult r = new DicomStoreScu()
                    .storeAll("127.0.0.1", port, "RCVSCP", "SENDER", List.of(a, b), null, TsPolicy.IMPLICIT_LE);
            assertEquals(2, r.sent(), r.messages().toString());
            assertEquals(0, r.failed());
        } finally {
            server.stop();
        }
        assertEquals(UID.ImplicitVRLittleEndian, CompressedFixtures.tsOf(rx.resolve(SOP_A + ".dcm")));
        assertEquals(UID.ImplicitVRLittleEndian, CompressedFixtures.tsOf(rx.resolve(SOP_B + ".dcm")));
        assertArrayEquals(wantPixels(), pixels(rx.resolve(SOP_B + ".dcm")));
    }

    @Test
    void まとめ送信_相手が指定の構文を受けなければ失敗に数える(@TempDir Path dir) throws Exception {
        Path a = stored(dir, SOP_A, UID.ExplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian);
        try {
            DicomStoreScu.BatchResult r = new DicomStoreScu()
                    .storeAll("127.0.0.1", port, "RCVSCP", "SENDER", List.of(a), null, TsPolicy.IMPLICIT_LE);
            assertEquals(0, r.sent());
            assertEquals(1, r.failed());
            assertTrue(r.messages().stream().anyMatch(m -> m.contains("指定の転送構文")), r.messages().toString());
        } finally {
            server.stop();
        }
        assertFalse(Files.exists(rx.resolve(SOP_A + ".dcm")));
    }

    @Test
    void 有損圧縮は変換せず_理由つきで失敗(@TempDir Path dir) throws Exception {
        // FMI が JPEG Baseline のファイル（読むのは FMI だけで、変換できない判定が先に出る）
        Path f = dir.resolve("lossy.dcm");
        Attributes ds = CompressedFixtures.ct(SOP_A, "TSPID");
        Attributes fmi = ds.createFileMetaInformation(UID.JPEGBaseline8Bit);
        try (DicomOutputStream dos = new DicomOutputStream(Files.newOutputStream(f), UID.ExplicitVRLittleEndian)) {
            dos.writeDataset(fmi, ds);
        }
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian);
        try {
            DicomStoreScu.BatchResult r = new DicomStoreScu()
                    .storeAll("127.0.0.1", port, "RCVSCP", "SENDER", List.of(f), null, TsPolicy.EXPLICIT_LE);
            assertEquals(0, r.sent());
            assertEquals(1, r.failed());
            assertTrue(r.messages().stream().anyMatch(m -> m.contains("変換しません")), r.messages().toString());
        } finally {
            server.stop();
        }
    }

    @Test
    void 可逆圧縮の保存は_復号して指定の構文で届く_画素が一致(@TempDir Path dir) throws Exception {
        PixelCodec codec = new PixelCodec(new DicomProperties());
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        Attributes ds = CompressedFixtures.ct(SOP_A, "TSPID");
        Path file = CompressedFixtures.compressed(dir.resolve("c.dcm"), ds, UID.JPEGLSLossless);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian, UID.ImplicitVRLittleEndian, UID.JPEGLSLossless);
        try {
            assertTrue(new DicomStoreScu(codec).store("127.0.0.1", port, "RCVSCP", "SENDER", file, null,
                    TsPolicy.IMPLICIT_LE).success());
        } finally {
            server.stop();
        }
        Path got = rx.resolve(SOP_A + ".dcm");
        assertEquals(UID.ImplicitVRLittleEndian, CompressedFixtures.tsOf(got), "相手が圧縮を受けても、指定が優先");
        assertArrayEquals(wantPixels(), pixels(got));
    }

    @Test
    void コーデックが無ければ_圧縮の保存は理由つきで失敗(@TempDir Path dir) throws Exception {
        PixelCodec codec = new PixelCodec(new DicomProperties());
        Assumptions.assumeTrue(codec.available(), "圧縮ファイルの用意に OpenCV が要る: " + codec.unavailableReason());
        Path file = CompressedFixtures.compressed(dir.resolve("c.dcm"), CompressedFixtures.ct(SOP_A, "TSPID"), UID.JPEGLSLossless);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian);
        try {
            DicomStoreScu.BatchResult r = new DicomStoreScu() // codec なし
                    .storeAll("127.0.0.1", port, "RCVSCP", "SENDER", List.of(file), null, TsPolicy.EXPLICIT_LE);
            assertEquals(1, r.failed());
            assertTrue(r.messages().stream().anyMatch(m -> m.contains("復号できません")), r.messages().toString());
        } finally {
            server.stop();
        }
    }
}
