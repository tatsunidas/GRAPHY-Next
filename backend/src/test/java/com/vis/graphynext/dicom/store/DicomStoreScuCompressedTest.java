/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.DicomScpServer;
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
import org.junit.jupiter.api.BeforeEach;
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
 * 圧縮して保管したファイルの C-STORE 送信。相手が元の転送構文を受けるなら素通し、
 * Explicit VR LE しか受けないなら復号して送る、どちらも受けないなら理由つきで失敗。
 */
class DicomStoreScuCompressedTest {

    private PixelCodec codec;

    @BeforeEach
    void setUp() {
        codec = new PixelCodec(new DicomProperties());
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
    }

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

    private static byte[] pixels(PixelCodec c, Path f) throws IOException {
        Attributes ds;
        String ts;
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            ts = in.getTransferSyntax();
        }
        return PixelCodec.isUncompressed(ts) ? ds.getBytes(Tag.PixelData) : c.decompress(ds, ts);
    }

    @Test
    void 相手がExplicitVRLEしか受けないなら_復号して送る_画素は元と一致(@TempDir Path dir) throws Exception {
        Attributes ds = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7101", "SENDPID");
        byte[] want = ds.getBytes(Tag.PixelData);
        Path file = CompressedFixtures.compressed(dir.resolve("c.dcm"), ds, UID.JPEGLSLossless);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian);
        try {
            DicomStoreScu.StoreResult r = new DicomStoreScu(codec).store("127.0.0.1", port, "RCVSCP", "SENDER", file);
            assertTrue(r.success(), r.message());
        } finally {
            server.stop();
        }
        Path got = rx.resolve("1.2.826.0.1.3680043.10.1338.7101.dcm");
        assertEquals(UID.ExplicitVRLittleEndian, CompressedFixtures.tsOf(got));
        assertArrayEquals(want, pixels(codec, got), "相手が受け取った画素が元と一致");
    }

    @Test
    void 相手が元の転送構文を受けるなら_そのまま送る_圧縮の中身がバイト一致(@TempDir Path dir) throws Exception {
        Attributes ds = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7102", "SENDPID");
        Path file = CompressedFixtures.compressed(dir.resolve("c.dcm"), ds, UID.JPEGLSLossless);
        List<byte[]> before = CompressedFixtures.fragments(file);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.JPEGLSLossless, UID.ExplicitVRLittleEndian);
        try {
            assertTrue(new DicomStoreScu(codec).store("127.0.0.1", port, "RCVSCP", "SENDER", file).success());
        } finally {
            server.stop();
        }
        Path got = rx.resolve("1.2.826.0.1.3680043.10.1338.7102.dcm");
        assertEquals(UID.JPEGLSLossless, CompressedFixtures.tsOf(got), "復号せず圧縮のまま");
        List<byte[]> after = CompressedFixtures.fragments(got);
        assertEquals(before.size(), after.size());
        for (int i = 0; i < before.size(); i++) {
            assertArrayEquals(before.get(i), after.get(i), "再符号化していない（フラグメント " + i + "）");
        }
    }

    @Test
    void どちらも受けない相手には_理由つきで失敗(@TempDir Path dir) throws Exception {
        Attributes ds = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7103", "SENDPID");
        Path file = CompressedFixtures.compressed(dir.resolve("c.dcm"), ds, UID.JPEGLSLossless);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ImplicitVRLittleEndian); // JPEG-LS も Explicit VR LE も受けない
        try {
            DicomStoreScu.StoreResult r = new DicomStoreScu(codec).store("127.0.0.1", port, "RCVSCP", "SENDER", file);
            assertFalse(r.success());
            assertTrue(r.message().contains("受け付けません"), r.message());
        } finally {
            server.stop();
        }
        assertFalse(Files.exists(rx.resolve("1.2.826.0.1.3680043.10.1338.7103.dcm")));
    }

    @Test
    void まとめ送信でも同じ_圧縮と非圧縮が混ざっていても全件届く(@TempDir Path dir) throws Exception {
        Attributes a = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7104", "SENDPID");
        Attributes b = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7105", "SENDPID");
        byte[] wantA = a.getBytes(Tag.PixelData);
        byte[] wantB = b.getBytes(Tag.PixelData);
        Path fa = CompressedFixtures.compressed(dir.resolve("a.dcm"), a, UID.JPEGLSLossless);
        Path fb = dir.resolve("b.dcm");
        CompressedFixtures.write(fb, b, UID.ExplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian);
        try {
            DicomStoreScu.BatchResult r = new DicomStoreScu(codec)
                    .storeAll("127.0.0.1", port, "RCVSCP", "SENDER", List.of(fa, fb), null);
            assertEquals(2, r.sent(), r.messages().toString());
            assertEquals(0, r.failed());
        } finally {
            server.stop();
        }
        assertArrayEquals(wantA, pixels(codec, rx.resolve("1.2.826.0.1.3680043.10.1338.7104.dcm")));
        assertArrayEquals(wantB, pixels(codec, rx.resolve("1.2.826.0.1.3680043.10.1338.7105.dcm")));
    }

    @Test
    void まとめ送信_どちらも受けない相手は失敗に数える(@TempDir Path dir) throws Exception {
        Attributes a = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7106", "SENDPID");
        Path fa = CompressedFixtures.compressed(dir.resolve("a.dcm"), a, UID.JPEGLSLossless);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ImplicitVRLittleEndian);
        try {
            DicomStoreScu.BatchResult r = new DicomStoreScu(codec)
                    .storeAll("127.0.0.1", port, "RCVSCP", "SENDER", List.of(fa), null);
            assertEquals(0, r.sent());
            assertEquals(1, r.failed());
            assertTrue(r.messages().stream().anyMatch(m -> m.contains("受け付けません")), r.messages().toString());
        } finally {
            server.stop();
        }
    }

    @Test
    void 非圧縮ファイルの送信は従来どおり(@TempDir Path dir) throws Exception {
        Attributes b = CompressedFixtures.ct("1.2.826.0.1.3680043.10.1338.7107", "SENDPID");
        byte[] want = b.getBytes(Tag.PixelData);
        Path fb = dir.resolve("b.dcm");
        CompressedFixtures.write(fb, b, UID.ExplicitVRLittleEndian);
        Path rx = Files.createDirectories(dir.resolve("rx"));
        int port = freePort();
        DicomScpServer server = scp(port, rx, UID.ExplicitVRLittleEndian);
        try {
            assertTrue(new DicomStoreScu().store("127.0.0.1", port, "RCVSCP", "SENDER", fb).success());
        } finally {
            server.stop();
        }
        assertArrayEquals(want, pixels(codec, rx.resolve("1.2.826.0.1.3680043.10.1338.7107.dcm")));
    }
}
