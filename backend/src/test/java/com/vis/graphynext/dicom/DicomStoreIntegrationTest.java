package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.junit.jupiter.api.io.TempDir;

import java.net.ServerSocket;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ローカル保管庫（FS + H2 索引）と C-STORE 受信のエンドツーエンド検証。
 * H2 はインメモリ、保管庫は一時ディレクトリに差し替える。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:storeit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomStoreIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;

    @Test
    void ingest_isIdempotent_and_indexed_with_fileUri() throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("PID1", "1.2.study.1", "1.2.series.1", "1.2.sop.1");

        // 同じインスタンスを 2 回取り込む（冪等のはず）
        storage.ingest(writePhantom(ds));
        storage.ingest(writePhantom(ds));

        List<DicomInstance> byStudy = storage.findMatches(null, "1.2.study.1", null, null);
        assertEquals(1, byStudy.size(), "再受信しても索引は 1 行（冪等）");

        DicomInstance inst = byStudy.get(0);
        assertTrue(inst.getUri().startsWith("file:"), "URI は file: スキーム");
        assertTrue(Files.exists(Path.of(URI.create(inst.getUri()))), "FS にファイルが存在する");

        // マッチングの各レベル
        assertEquals(1, storage.findMatches("PID1", null, null, null).size());
        assertEquals(1, storage.findMatches(null, null, "1.2.series.1", null).size());
        assertEquals(1, storage.findMatches(null, null, null, "1.2.sop.1").size());
        assertEquals(0, storage.findMatches(null, "no.such.study", null, null).size());
    }

    @Test
    void cStore_endToEnd_storesAndIndexes() throws Exception {
        int port = freePort();
        DicomScpServer scp = new DicomScpServer("GRAPHYSTORE", "127.0.0.1", port);
        scp.addService(
                new DicomStoreScp(storage, tmp.resolve("scp-incoming")),
                new TransferCapability(null, "*", TransferCapability.Role.SCP, "*"));
        scp.start();
        try {
            Attributes ds = DicomPhantomFactory.scImage("PID2", "1.2.study.2", "1.2.series.2", "1.2.sop.2");
            Path file = writePhantom(ds);

            DicomStoreScu.StoreResult r =
                    new DicomStoreScu().store("127.0.0.1", port, "GRAPHYSTORE", "SCU", file);

            assertTrue(r.success(), () -> "C-STORE should succeed: " + r.message());
            List<DicomInstance> m = storage.findMatches(null, "1.2.study.2", null, null);
            assertEquals(1, m.size(), "受信したインスタンスが索引に載る");
        } finally {
            scp.stop();
        }
    }

    @Test
    void listStudies_groupsInstancesByStudy() throws Exception {
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PA", "ST.A", "SE.A", "SOP.A1")));
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PA", "ST.A", "SE.A", "SOP.A2")));
        storage.ingest(writePhantom(DicomPhantomFactory.scImage("PB", "ST.B", "SE.B", "SOP.B1")));

        var studies = storage.listStudies();
        var a = studies.stream().filter(s -> "ST.A".equals(s.studyInstanceUid())).findFirst().orElseThrow();
        assertEquals(2, a.numberOfInstances(), "ST.A はインスタンス2件");
        assertEquals("PA", a.patientId());
        assertTrue(studies.stream().anyMatch(s -> "ST.B".equals(s.studyInstanceUid())), "ST.B も一覧に出る");
    }

    private static Path writePhantom(Attributes ds) throws Exception {
        Path f = Files.createTempFile("phantom", ".dcm");
        return DicomPhantomFactory.writeFile(f, ds, UID.ExplicitVRLittleEndian);
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}
