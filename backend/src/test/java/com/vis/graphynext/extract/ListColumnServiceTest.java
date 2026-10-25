/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageBackend;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.extract.ListColumnService.Cell;
import com.vis.graphynext.extract.ListColumnService.Column;
import com.vis.graphynext.extract.ListColumnService.State;
import com.vis.graphynext.extract.TagExtractService.Seg;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 一覧の列（タグ値の読み取り）の検証。値は TagExtractor と同じになること、タグが無いのと空なのを区別すること、
 * 読めない理由を区別すること、Drive から取り寄せないこと、古い値が残らないこと、何も書かないことを確かめる。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:listcolumns;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
@ActiveProfiles("standalone")
class ListColumnServiceTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    ListColumnService service;
    @Autowired
    TagExtractService extract;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;

    private static final Column PROTOCOL = col("protocol", seg("00181030"));

    @AfterEach
    void resetBackend() {
        layout.setBackend(null);
    }

    private static Seg seg(String tag) {
        return new Seg(tag, null);
    }

    private static Column col(String id, Seg... segs) {
        return new Column(id, List.of(segs));
    }

    /** 1 枚を取り込み、保管庫の中のパスを返す。 */
    private Path ingest(String study, String series, String sop, Consumer<Attributes> edit) throws Exception {
        return ingest(study, series, sop, UID.ExplicitVRLittleEndian, edit);
    }

    private Path ingest(String study, String series, String sop, String transferSyntax, Consumer<Attributes> edit)
            throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("PID-" + study, study, series, sop);
        edit.accept(ds);
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("lc", ".dcm"), ds, transferSyntax);
        storage.ingest(f);
        DicomInstance inst = repo.findBySeries(study, series).stream()
                .filter(i -> sop.equals(i.getSopInstanceUid())).findFirst().orElseThrow();
        Path stored = layout.localPath(inst);
        assertNotNull(stored, "取り込んだファイルが保管庫に実在する");
        return stored;
    }

    private Cell studyCell(String study, Column c) {
        return service.studyCells(List.of(study), List.of(c)).get(study).get(c.id());
    }

    private Cell seriesCell(String study, String series, Column c) {
        return service.seriesCells(study, List.of(c)).get(series).get(c.id());
    }

    @Test
    void studyValueJoinsDistinctSeriesValues_andSeriesRowsKeepTheirOwn() throws Exception {
        ingest("ST.A", "SE.A1", "SOP.A1", d -> d.setString(Tag.ProtocolName, VR.LO, "Chest 1.0"));
        ingest("ST.A", "SE.A2", "SOP.A2", d -> d.setString(Tag.ProtocolName, VR.LO, "WB PET"));
        ingest("ST.A", "SE.A3", "SOP.A3", d -> d.setString(Tag.ProtocolName, VR.LO, "WB PET")); // 重複は 1 つにまとめる

        Cell study = studyCell("ST.A", PROTOCOL);
        assertEquals(State.OK, study.state());
        assertEquals(List.of("Chest 1.0", "WB PET"), study.values().stream().sorted().toList());
        assertFalse(study.incomplete());

        assertEquals(List.of("Chest 1.0"), seriesCell("ST.A", "SE.A1", PROTOCOL).values());
        assertEquals(List.of("WB PET"), seriesCell("ST.A", "SE.A2", PROTOCOL).values());
    }

    @Test
    void sequenceAndPrivateTagsGiveTheSameValuesAsTagExtractor() throws Exception {
        ingest("ST.B", "SE.B", "SOP.B", d -> {
            Attributes item = new Attributes();
            item.setString(Tag.ScheduledProcedureStepID, VR.SH, "SPS123");
            Sequence seq = d.newSequence(Tag.RequestAttributesSequence, 1);
            seq.add(item);
            d.setString("VIS-PRIVATE", 0x00190001, VR.LO, "PRIVVAL");
            d.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY");
        });
        Column nested = col("sq", seg("00400275"), seg("00400009"));
        Column priv = col("pv", new Seg("00190001", "VIS-PRIVATE"));
        Column multi = col("mv", seg("00080008"));

        List<TagExtractService.TagPath> paths = List.of(
                new TagExtractService.TagPath(nested.segments(), "sq"),
                new TagExtractService.TagPath(priv.segments(), "pv"),
                new TagExtractService.TagPath(multi.segments(), "mv"));
        TagExtractService.TableResult t = extract.extractTable(List.of("ST.B"), paths);
        List<String> row = t.rows().get(0);

        Map<String, Cell> cells = service.studyCells(List.of("ST.B"), List.of(nested, priv, multi)).get("ST.B");
        assertEquals(row.get(t.columns().indexOf("sq")), cells.get("sq").values().get(0));
        assertEquals(row.get(t.columns().indexOf("pv")), cells.get("pv").values().get(0));
        assertEquals(row.get(t.columns().indexOf("mv")), cells.get("mv").values().get(0));
        assertEquals("SPS123", cells.get("sq").values().get(0), "検査が空振りでないこと（期待値が実在する）");
        assertEquals("PRIVVAL", cells.get("pv").values().get(0));
        assertEquals("DERIVED\\SECONDARY", cells.get("mv").values().get(0));
    }

    @Test
    void implicitVrPrivateTextIsShownAsText() throws Exception {
        ingest("ST.IV", "SE.IV", "SOP.IV", UID.ImplicitVRLittleEndian,
                d -> d.setString("VIS-PRIVATE", 0x00190001, VR.LO, "PRIV-1"));
        Column priv = col("pv", new Seg("00190001", "VIS-PRIVATE"));

        Map<String, Cell> cells = service.studyCells(List.of("ST.IV"), List.of(priv)).get("ST.IV");
        assertEquals("PRIV-1", cells.get("pv").values().get(0));
    }

    @Test
    void absentTagAndEmptyValueAreDistinguished() throws Exception {
        ingest("ST.C", "SE.C1", "SOP.C1", d -> d.setString(Tag.ProtocolName, VR.LO, "")); // タグはあるが空
        ingest("ST.C", "SE.C2", "SOP.C2", d -> { });                                   // タグが無い

        Cell empty = seriesCell("ST.C", "SE.C1", PROTOCOL);
        Cell absent = seriesCell("ST.C", "SE.C2", PROTOCOL);
        assertEquals(State.OK, empty.state());
        assertTrue(empty.values().isEmpty());
        assertEquals(State.ABSENT, absent.state());
    }

    @Test
    void deletedFileIsUnreadable_notAbsent() throws Exception {
        Path f = ingest("ST.D", "SE.D", "SOP.D", d -> d.setString(Tag.ProtocolName, VR.LO, "X"));
        assertEquals(State.OK, seriesCell("ST.D", "SE.D", PROTOCOL).state());
        Files.delete(f);
        assertEquals(State.UNREADABLE, seriesCell("ST.D", "SE.D", PROTOCOL).state());
        assertEquals(State.UNREADABLE, studyCell("ST.D", PROTOCOL).state());
    }

    @Test
    void driveCacheModeShowsNotLocalAndNeverDownloads() throws Exception {
        Path f = ingest("ST.E", "SE.E", "SOP.E", d -> d.setString(Tag.ProtocolName, VR.LO, "X"));
        Files.delete(f); // 手元に無い（Drive にだけある）状況
        AtomicInteger fetches = new AtomicInteger();
        layout.setBackend(new StorageBackend() {
            @Override
            public boolean cacheMode() {
                return true;
            }

            @Override
            public Path ensureLocal(String relPath) {
                fetches.incrementAndGet();
                return null;
            }

            @Override
            public void prefetch(Collection<String> relPaths, BooleanSupplier cancelled) {
                fetches.incrementAndGet();
            }

            @Override
            public void touch(String relPath) {
            }
        });

        assertEquals(State.NOT_LOCAL, seriesCell("ST.E", "SE.E", PROTOCOL).state());
        assertEquals(State.NOT_LOCAL, studyCell("ST.E", PROTOCOL).state());
        assertEquals(0, fetches.get(), "一覧を眺めただけで Drive から取り寄せない");
    }

    @Test
    void rereadIsServedFromMemory_andReplacedFileGivesTheNewValue() throws Exception {
        Path f = ingest("ST.F", "SE.F", "SOP.F", d -> d.setString(Tag.ProtocolName, VR.LO, "OLD"));
        long r0 = service.headerReadCount();
        assertEquals(List.of("OLD"), seriesCell("ST.F", "SE.F", PROTOCOL).values());
        long r1 = service.headerReadCount();
        assertEquals(r0 + 1, r1, "初回はヘッダを読む");
        assertEquals(List.of("OLD"), seriesCell("ST.F", "SE.F", PROTOCOL).values());
        assertEquals(r1, service.headerReadCount(), "2 回目は覚えた値を使う（ヘッダを読まない）");

        // 大きさの変わる入れ替え（タグ編集・患者情報編集と同じ。同じ SOP UID の別内容）
        Attributes ds = DicomPhantomFactory.scImage("PID-ST.F", "ST.F", "SE.F", "SOP.F");
        ds.setString(Tag.ProtocolName, VR.LO, "A MUCH LONGER NEW VALUE");
        DicomPhantomFactory.writeFile(f, ds, UID.ExplicitVRLittleEndian);
        assertEquals(List.of("A MUCH LONGER NEW VALUE"), seriesCell("ST.F", "SE.F", PROTOCOL).values(),
                "古い値が残らない（大きさが変わった）");
    }

    @Test
    void sameSizeReplacementIsDetectedByModifiedTime() throws Exception {
        Path f = ingest("ST.G", "SE.G", "SOP.G", d -> d.setString(Tag.ProtocolName, VR.LO, "AAA"));
        assertEquals(List.of("AAA"), seriesCell("ST.G", "SE.G", PROTOCOL).values());
        FileTime before = Files.getLastModifiedTime(f);

        Attributes ds = DicomPhantomFactory.scImage("PID-ST.G", "ST.G", "SE.G", "SOP.G");
        ds.setString(Tag.ProtocolName, VR.LO, "BBB"); // 同じ長さ
        DicomPhantomFactory.writeFile(f, ds, UID.ExplicitVRLittleEndian);
        Files.setLastModifiedTime(f, FileTime.fromMillis(before.toMillis() + 5000));
        assertEquals(List.of("BBB"), seriesCell("ST.G", "SE.G", PROTOCOL).values(), "古い値が残らない（更新時刻だけが変わった）");
    }

    @Test
    void readingWritesNothing_neitherTheIndexNorTheFiles() throws Exception {
        Path f = ingest("ST.H", "SE.H", "SOP.H", d -> d.setString(Tag.ProtocolName, VR.LO, "X"));
        long rows = repo.count();
        assertTrue(rows > 0, "索引に行がある（比較の前提）");
        String hash = sha256(f);

        studyCell("ST.H", PROTOCOL);
        seriesCell("ST.H", "SE.H", PROTOCOL);
        service.studyCells(List.of("ST.H"), List.of(PROTOCOL, col("sq", seg("00400275"), seg("00400009"))));

        assertEquals(rows, repo.count(), "索引の行数が変わらない");
        assertEquals(hash, sha256(f), "ファイルが変わらない");
    }

    @Test
    void webQidoGetsIncludefieldAndMissingAttributesAreNotReturned() {
        WebDicomDataService web = mock(WebDicomDataService.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<WebDicomDataService> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(web);

        Attributes withValue = new Attributes();
        withValue.setString(Tag.SeriesInstanceUID, VR.UI, "SE.W1");
        withValue.setString(Tag.ProtocolName, VR.LO, "Web Protocol");
        Attributes without = new Attributes();
        without.setString(Tag.SeriesInstanceUID, VR.UI, "SE.W2"); // PACS が返さなかった
        when(web.searchSeries(eq("ST.W"), any())).thenReturn(List.of(withValue, without));

        ListColumnService svc = new ListColumnService(mock(DicomInstanceRepository.class), provider, layout);
        Map<String, Map<String, Cell>> bySeries = svc.seriesCells("ST.W", List.of(PROTOCOL));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, String>> q = ArgumentCaptor.forClass(Map.class);
        verify(web).searchSeries(eq("ST.W"), q.capture());
        assertEquals("00181030", q.getValue().get("includefield"));

        assertEquals(State.OK, bySeries.get("SE.W1").get("protocol").state());
        assertEquals(List.of("Web Protocol"), bySeries.get("SE.W1").get("protocol").values());
        assertEquals(State.NOT_RETURNED, bySeries.get("SE.W2").get("protocol").state());

        Cell study = svc.studyCells(List.of("ST.W"), List.of(PROTOCOL)).get("ST.W").get("protocol");
        assertEquals(State.OK, study.state());
        assertTrue(study.incomplete(), "一部のシリーズは PACS が返さなかった");
    }

    private static String sha256(Path p) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(p)));
    }
}
