/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import com.vis.graphynext.dicom.store.ReceiveCompressor;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.imageio.codec.Compressor;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 受信時の可逆圧縮（C-STORE SCP）の結合テスト。SCP をテストの中で起動し、実際に C-STORE で送る。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:recvcomp;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ReceiveCompressIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
        registry.add("graphy.receive-anonymize.key-file", () -> tmp.resolve("keys/receive-anon.key").toString());
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    com.vis.graphynext.dicom.store.StorageLayout layout;
    @Autowired
    SettingsService settings;
    @Autowired
    ReceiveCompressor compressor;
    @Autowired
    PixelCodec codec;

    private int seq;

    @BeforeEach
    void reset() {
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        settings.putAll(Map.of(ReceiveCompressor.KEY, ReceiveCompressor.MODE_JPEGLS));
    }

    private Attributes ct(String sop) {
        Attributes a = DicomPhantomFactory.scImage("RCPID", "1.2.826.0.1.3680043.10.1338.9001", "1.2.826.0.1.3680043.10.1338.9002", sop);
        a.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        a.setString(Tag.Modality, VR.CS, "CT");
        a.setInt(Tag.Rows, VR.US, 64);
        a.setInt(Tag.Columns, VR.US, 64);
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.PixelRepresentation, VR.US, 1);
        ByteBuffer bb = ByteBuffer.allocate(64 * 64 * 2).order(ByteOrder.LITTLE_ENDIAN);
        Random r = new Random(3);
        for (int y = 0; y < 64; y++) {
            for (int x = 0; x < 64; x++) {
                boolean body = (x - 32) * (x - 32) + (y - 32) * (y - 32) < 700;
                bb.putShort((short) ((body ? 40 + y % 9 : -1000) + r.nextInt(7) - 3));
            }
        }
        a.setBytes(Tag.PixelData, VR.OW, bb.array());
        return a;
    }

    private Path write(Attributes ds, String ts) throws IOException {
        return DicomPhantomFactory.writeFile(tmp.resolve("send-" + (seq++) + ".dcm"), ds, ts);
    }

    /** 送信用の圧縮済みファイル（テスト側で作る）。 */
    private Path writeJpegLs(Attributes ds) throws IOException {
        Path raw = write(ds, UID.ExplicitVRLittleEndian);
        Attributes src;
        try (DicomInputStream in = new DicomInputStream(raw.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            src = in.readDataset(-1, -1);
        }
        try (Compressor c = new Compressor(src, UID.ExplicitVRLittleEndian)) {
            assertTrue(c.compress(UID.JPEGLSLossless));
            return DicomPhantomFactory.writeFile(tmp.resolve("send-" + (seq++) + ".dcm"), src, UID.JPEGLSLossless);
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    private DicomInstance receive(Path file, String sop) throws Exception {
        int port = freePort();
        DicomScpServer scp = new DicomScpServer("GRAPHYSTORE", "127.0.0.1", port);
        scp.addService(new DicomStoreScp(storage, tmp.resolve("incoming"), null, compressor),
                new TransferCapability(null, "*", TransferCapability.Role.SCP, "*"));
        scp.start();
        try {
            DicomStoreScu.StoreResult r = new DicomStoreScu().store("127.0.0.1", port, "GRAPHYSTORE", "SENDER", file);
            assertTrue(r.success(), "C-STORE が成功する");
        } finally {
            scp.stop();
        }
        List<DicomInstance> found = storage.findMatches(null, null, null, sop);
        assertEquals(1, found.size());
        return found.get(0);
    }

    private byte[] decodedPixels(Path f) throws IOException {
        Attributes ds;
        String ts;
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, -1);
            ts = in.getTransferSyntax();
        }
        return PixelCodec.isUncompressed(ts) ? ds.getBytes(Tag.PixelData) : codec.decompress(ds, ts);
    }

    private static List<byte[]> fragments(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            Object v = in.readDataset(-1, -1).getValue(Tag.PixelData);
            assertTrue(v instanceof Fragments);
            List<byte[]> out = new ArrayList<>();
            for (Object o : (Fragments) v) {
                out.add(o instanceof byte[] b ? b : new byte[0]);
            }
            return out;
        }
    }

    @Test
    void 設定オンでC_STOREすると_保管庫と索引がJPEGLS可逆になり_画素は一致する() throws Exception {
        String sop = "1.2.826.0.1.3680043.10.1338.9101";
        Attributes ds = ct(sop);
        Path sent = write(ds, UID.ExplicitVRLittleEndian);
        byte[] want = ds.getBytes(Tag.PixelData);

        DicomInstance inst = receive(sent, sop);

        assertEquals(UID.JPEGLSLossless, inst.getTransferSyntaxUid(), "索引の転送構文が新しい値");
        Path stored = storageFile(inst);
        assertEquals(Files.size(stored), inst.getSizeBytes(), "索引のサイズは保管庫のファイルと一致");
        assertTrue(inst.getSizeBytes() < Files.size(sent), "送ったファイルより小さい");
        assertArrayEquals(want, decodedPixels(stored), "復号した画素が送った画素と一致");
    }

    @Test
    void 設定オフなら従来どおり_非圧縮のまま() throws Exception {
        settings.putAll(Map.of(ReceiveCompressor.KEY, "off"));
        String sop = "1.2.826.0.1.3680043.10.1338.9102";
        Attributes ds = ct(sop);
        byte[] want = ds.getBytes(Tag.PixelData);
        DicomInstance inst = receive(write(ds, UID.ExplicitVRLittleEndian), sop);
        assertEquals(UID.ExplicitVRLittleEndian, inst.getTransferSyntaxUid());
        assertArrayEquals(want, decodedPixels(storageFile(inst)));
    }

    @Test
    void すでに圧縮済みを送っても多重圧縮しない_圧縮の中身が送ったものと同じ() throws Exception {
        String sop = "1.2.826.0.1.3680043.10.1338.9103";
        Path sent = writeJpegLs(ct(sop));
        List<byte[]> before = fragments(sent);
        long skippedBefore = compressor.status().skipped().getOrDefault("already-compressed", 0L);

        DicomInstance inst = receive(sent, sop);

        assertEquals(UID.JPEGLSLossless, inst.getTransferSyntaxUid());
        List<byte[]> after = fragments(storageFile(inst));
        assertEquals(before.size(), after.size());
        for (int i = 0; i < before.size(); i++) {
            assertArrayEquals(before.get(i), after.get(i), "圧縮された画素のバイト列が 1 バイトも変わらない（フラグメント " + i + "）");
        }
        assertEquals(skippedBefore + 1, compressor.status().skipped().get("already-compressed"));
    }

    private Path storageFile(DicomInstance inst) {
        Path p = layout.resolveForRead(inst);
        assertNotNull(p);
        return p;
    }
}
