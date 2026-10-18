/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 任意タグの編集: 範囲の全ファイルと索引が新しい値になり、画素・UID は変わらず、前の値が Original Attributes Sequence に残る。
 * 決まりに合わない編集・途中の失敗では 1 ファイルも変わらない。落ちたときの復旧は種類（タグの編集）ごとに判定する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:tagedit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class TagEditTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    TagEditService service;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;
    @Autowired
    DicomEditRecovery recovery;

    /** {@code @Transactional} の代理ではなく本体（ファイル操作の差し替え先）。 */
    private TagEditService target() {
        return org.springframework.test.util.AopTestUtils.getTargetObject(service);
    }

    @AfterEach
    void restoreOps() {
        target().ops = DicomFileEdit.Ops.REAL;
    }

    private void ingest(String study, String series, String sop, String seriesDesc, int seed) throws Exception {
        ingest(study, series, sop, seriesDesc, seed, null);
    }

    private void ingest(String study, String series, String sop, String seriesDesc, int seed, Attributes extra) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("TE-" + study, study, series, sop);
        ds.setString(Tag.SeriesDescription, VR.LO, seriesDesc);
        ds.setString(Tag.StudyDescription, VR.LO, "Study A");
        byte[] px = new byte[16];
        for (int i = 0; i < px.length; i++) {
            px[i] = (byte) (seed * 31 + i * 7);
        }
        ds.setBytes(Tag.PixelData, VR.OB, px);
        if (extra != null) {
            ds.addAll(extra);
        }
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("te", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
    }

    private Path fileOf(String sop) {
        return layout.resolveForRead(repo.findById(sop).orElseThrow());
    }

    private static Attributes read(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDataset();
        }
    }

    private List<String> leftovers() throws IOException {
        try (Stream<Path> s = Files.walk(layout.root())) {
            return s.filter(Files::isRegularFile).map(p -> p.getFileName().toString())
                    .filter(n -> n.endsWith(".edit") || n.endsWith(".orig") || n.endsWith(".journal")).sorted().toList();
        }
    }

    private static TagEditService.Scope series(String study, String series) {
        return new TagEditService.Scope("series", study, series, null);
    }

    private static TagEditService.Edit set(String tag, String before, String value) {
        return new TagEditService.Edit(tag, null, "set", before, value);
    }

    private List<byte[]> bytes(String... sops) throws IOException {
        List<byte[]> out = new ArrayList<>();
        for (String s : sops) {
            out.add(Files.readAllBytes(fileOf(s)));
        }
        return out;
    }

    private void assertUnchanged(List<byte[]> before, String... sops) throws IOException {
        for (int i = 0; i < sops.length; i++) {
            assertArrayEquals(before.get(i), Files.readAllBytes(fileOf(sops[i])), "ファイルは変わらない: " + sops[i]);
        }
    }

    /** 最後に足された Original Attributes Sequence の項目の Modified Attributes Sequence。 */
    private static Attributes lastModified(Attributes ds) {
        Sequence oas = ds.getSequence(Tag.OriginalAttributesSequence);
        assertNotNull(oas, "Original Attributes Sequence がある");
        Attributes item = oas.get(oas.size() - 1);
        assertEquals("GRAPHY-Next", item.getString(Tag.ModifyingSystem));
        assertEquals("CORRECT", item.getString(Tag.ReasonForTheAttributeModification));
        assertNotNull(item.getDate(Tag.AttributeModificationDateTime));
        return item.getNestedDataset(Tag.ModifiedAttributesSequence);
    }

    // ── 正例 ──

    @Test
    void シリーズの説明を変えると_全ファイルと索引が新しい値_画素とUIDは同じ_前の値が残る() throws Exception {
        for (int i = 1; i <= 3; i++) {
            ingest("TE1.st", "TE1.se", "TE1.s" + i, "Chest", i);
        }
        ingest("TE1.st", "TE1.other", "TE1.o1", "Other", 9);
        List<byte[]> pixels = new ArrayList<>();
        for (int i = 1; i <= 3; i++) {
            pixels.add(read(fileOf("TE1.s" + i)).getBytes(Tag.PixelData));
        }
        byte[] other = Files.readAllBytes(fileOf("TE1.o1"));

        var preview = service.preview(series("TE1.st", "TE1.se"), List.of(set("SeriesDescription", "Chest", "Chest 1.0")));
        assertEquals(3, preview.files());
        assertEquals(0, preview.items().get(0).differing());

        var result = service.apply(series("TE1.st", "TE1.se"), List.of(set("SeriesDescription", "Chest", "Chest 1.0")));
        assertEquals(3, result.updatedFiles());
        assertEquals(List.of("SERIES_DESCRIPTION"), result.indexColumns());
        for (int i = 1; i <= 3; i++) {
            String sop = "TE1.s" + i;
            Attributes ds = read(fileOf(sop));
            assertEquals("Chest 1.0", ds.getString(Tag.SeriesDescription));
            assertEquals(sop, ds.getString(Tag.SOPInstanceUID));
            assertArrayEquals(pixels.get(i - 1), ds.getBytes(Tag.PixelData), "画素は同じ");
            assertEquals("Chest", lastModified(ds).getString(Tag.SeriesDescription), "前の値");
            assertEquals("Chest 1.0", repo.findById(sop).orElseThrow().getSeriesDescription(), "索引も新しい値");
        }
        assertArrayEquals(other, Files.readAllBytes(fileOf("TE1.o1")), "範囲外のシリーズは変わらない");
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 索引に無いタグを足す_変える_消す() throws Exception {
        ingest("TE2.st", "TE2.se", "TE2.s1", "S", 1);
        var scope = series("TE2.st", "TE2.se");

        var r = service.apply(scope, List.of(set("ProtocolName", "", "Routine")));
        assertEquals(List.of(), r.indexColumns());
        Attributes ds = read(fileOf("TE2.s1"));
        assertEquals("Routine", ds.getString(Tag.ProtocolName));
        Attributes mod = lastModified(ds);
        assertTrue(mod.contains(Tag.ProtocolName) && !mod.containsValue(Tag.ProtocolName), "無かったタグは空の値で記録");

        service.apply(scope, List.of(set("(0018,1030)", "Routine", "Routine 2")));
        assertEquals("Routine 2", read(fileOf("TE2.s1")).getString(Tag.ProtocolName));

        service.apply(scope, List.of(new TagEditService.Edit("ProtocolName", null, "remove", "Routine 2", null)));
        ds = read(fileOf("TE2.s1"));
        assertFalse(ds.contains(Tag.ProtocolName));
        assertEquals("Routine 2", lastModified(ds).getString(Tag.ProtocolName), "消した値も残る");
        assertEquals(3, ds.getSequence(Tag.OriginalAttributesSequence).size(), "編集のたびに 1 項目");
        assertEquals(List.of(), leftovers());
    }

    @Test
    void スタディの範囲は全シリーズ_画像の範囲は1枚だけ() throws Exception {
        ingest("TE3.st", "TE3.a", "TE3.a1", "A", 1);
        ingest("TE3.st", "TE3.b", "TE3.b1", "B", 2);
        ingest("TE3.st", "TE3.b", "TE3.b2", "B", 3);
        service.apply(new TagEditService.Scope("study", "TE3.st", null, null),
                List.of(set("StudyDescription", "Study A", "CT Chest")));
        for (String sop : List.of("TE3.a1", "TE3.b1", "TE3.b2")) {
            assertEquals("CT Chest", read(fileOf(sop)).getString(Tag.StudyDescription));
            assertEquals("CT Chest", repo.findById(sop).orElseThrow().getStudyDescription());
        }
        service.apply(new TagEditService.Scope("instance", "TE3.st", "TE3.b", "TE3.b2"),
                List.of(set("InstanceNumber", "1", "7")));
        assertEquals(7, read(fileOf("TE3.b2")).getInt(Tag.InstanceNumber, 0));
        assertEquals(7, repo.findById("TE3.b2").orElseThrow().getInstanceNumber());
        assertEquals(1, read(fileOf("TE3.b1")).getInt(Tag.InstanceNumber, 0), "同じシリーズの別の画像は変わらない");
    }

    @Test
    void 確認は_見えていた値と異なる画像を数える() throws Exception {
        ingest("TE4.st", "TE4.se", "TE4.s1", "X", 1);
        ingest("TE4.st", "TE4.se", "TE4.s2", "Y", 2);
        var p = service.preview(series("TE4.st", "TE4.se"), List.of(set("SeriesDescription", "X", "Z")));
        assertEquals(2, p.files());
        assertEquals(1, p.items().get(0).differing());
        assertEquals("X", read(fileOf("TE4.s1")).getString(Tag.SeriesDescription), "確認では書かない");
    }

    @Test
    void プライベートタグは_Private_Creator_がある画像にだけ足せる() throws Exception {
        Attributes creator = new Attributes();
        creator.setString(0x00090010, VR.LO, "ACME 1.0");
        ingest("TE5.st", "TE5.se", "TE5.s1", "S", 1, creator);
        ingest("TE5.st", "TE5.no", "TE5.n1", "S", 2);
        var ok = new TagEditService.Edit("(0009,1001)", "LO", "set", "", "note");
        service.apply(series("TE5.st", "TE5.se"), List.of(ok));
        assertEquals("note", read(fileOf("TE5.s1")).getString(0x00091001));

        List<byte[]> before = bytes("TE5.n1");
        var ex = assertThrows(TagEditService.InvalidEditException.class,
                () -> service.apply(series("TE5.st", "TE5.no"), List.of(ok)));
        assertEquals("privateCreatorMissing", ex.problems().get(0).reason());
        assertUnchanged(before, "TE5.n1");
    }

    // ── 負例 ──

    @Test
    void 編集できないタグや形の違う値は_400で_1ファイルも変わらない() throws Exception {
        ingest("TE6.st", "TE6.se", "TE6.s1", "S", 1);
        ingest("TE6.st", "TE6.se", "TE6.s2", "S", 2);
        List<byte[]> before = bytes("TE6.s1", "TE6.s2");
        var scope = series("TE6.st", "TE6.se");
        record Case(TagEditService.Edit edit, String reason) {
        }
        List<Case> cases = List.of(
                new Case(set("SeriesInstanceUID", "", "1.2.3"), "uid"),
                new Case(set("Rows", "4", "8"), "pixel"),
                new Case(new TagEditService.Edit("PixelData", null, "remove", "", null), "pixel"),
                new Case(set("ImagePositionPatient", "", "0\\0\\0"), "geometry"),
                new Case(set("PatientName", "", "X^Y"), "patient"),
                new Case(set("ReferencedImageSequence", "", ""), "sequence"),
                new Case(new TagEditService.Edit("(0009,1001)", "OB", "set", "", "1"), "binary"),
                new Case(set("StudyDate", "20260101", "20261345"), "format"),
                new Case(set("Modality", "OT", "ct"), "badChars"),
                new Case(set("NoSuchKeyword", "", "x"), "badTag"));
        for (Case c : cases) {
            var ex = assertThrows(TagEditService.InvalidEditException.class, () -> service.apply(scope, List.of(c.edit())),
                    c.edit().tag());
            assertEquals(c.reason(), ex.problems().get(0).reason(), c.edit().tag());
        }
        // 正しい編集と混ざっていても、1 つでも違反があれば何も書かない
        assertThrows(TagEditService.InvalidEditException.class, () -> service.apply(scope,
                List.of(set("SeriesDescription", "S", "OK"), set("SOPInstanceUID", "", "9.9"))));
        assertUnchanged(before, "TE6.s1", "TE6.s2");
        assertEquals("S", repo.findById("TE6.s1").orElseThrow().getSeriesDescription());
    }

    @Test
    void 入れ替えの途中で失敗したら_全ファイルも索引も編集前のまま() throws Exception {
        ingest("TE7.st", "TE7.se", "TE7.s1", "Old", 1);
        ingest("TE7.st", "TE7.se", "TE7.s2", "Old", 2);
        ingest("TE7.st", "TE7.se", "TE7.s3", "Old", 3);
        List<byte[]> before = bytes("TE7.s1", "TE7.s2", "TE7.s3");
        int[] placed = {0};
        target().ops = new DicomFileEdit.Ops() {
            @Override
            public void move(Path from, Path to) throws IOException {
                if (from.getFileName().toString().endsWith(".edit") && ++placed[0] == 2) {
                    throw new IOException("入れ替えの失敗を模擬");
                }
                DicomFileEdit.Ops.REAL.move(from, to);
            }

            @Override
            public void delete(Path p) throws IOException {
                DicomFileEdit.Ops.REAL.delete(p);
            }
        };
        var ex = assertThrows(ResponseStatusException.class,
                () -> service.apply(series("TE7.st", "TE7.se"), List.of(set("SeriesDescription", "Old", "New"))));
        assertEquals(409, ex.getStatusCode().value());
        assertTrue(ex.getReason().startsWith("tag-edit-failed"), ex.getReason());
        assertUnchanged(before, "TE7.s1", "TE7.s2", "TE7.s3");
        for (DicomInstance r : repo.findBySeries("TE7.st", "TE7.se")) {
            assertEquals("Old", r.getSeriesDescription(), "索引も編集前");
        }
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 実体の無い画像が範囲にあれば_編集全体を断る() throws Exception {
        ingest("TE8.st", "TE8.se", "TE8.s1", "Old", 1);
        ingest("TE8.st", "TE8.se", "TE8.s2", "Old", 2);
        List<byte[]> before = bytes("TE8.s2");
        Files.delete(fileOf("TE8.s1"));
        var ex = assertThrows(ResponseStatusException.class,
                () -> service.apply(series("TE8.st", "TE8.se"), List.of(set("SeriesDescription", "Old", "New"))));
        assertEquals(409, ex.getStatusCode().value());
        assertUnchanged(before, "TE8.s2");
    }

    // ── 起動時の復旧 ──

    private Path journalDir() {
        return layout.root().resolve(".edit-journal");
    }

    /** タグの編集を「入れ替え済み・未確定」で止める。 */
    private Path crashAfterSwap(String sop, String newDesc, Collection<IndexedTag> cols) throws Exception {
        Path f = fileOf(sop);
        var c = List.of(set("SeriesDescription", "", newDesc));
        DicomFileEdit e = DicomFileEdit.prepare(List.of(new DicomFileEdit.Target(sop, f)),
                (src, dst) -> TagEditService.rewrite(src, dst, TagEditService.check(c), new java.util.Date()),
                journalDir(), new FileRetry(ms -> { }), DicomFileEdit.Ops.REAL,
                DicomFileEdit.Kind.tags(cols.isEmpty() ? java.util.EnumSet.noneOf(IndexedTag.class) : java.util.EnumSet.copyOf(cols)));
        e.swap();
        return f;
    }

    private void dropSwappedMark() throws IOException {
        try (Stream<Path> js = Files.list(journalDir())) {
            for (Path j : js.toList()) {
                List<String> lines = Files.readAllLines(j, StandardCharsets.UTF_8).stream()
                        .filter(l -> !l.equals(DicomFileEdit.SWAPPED_MARK)).toList();
                Files.write(j, lines, StandardCharsets.UTF_8);
            }
        }
    }

    @Test
    void 復旧_入れ替えを終えた印が無ければ_元へ戻す() throws Exception {
        ingest("TR1.st", "TR1.se", "TR1.s1", "Old", 1);
        Path f = crashAfterSwap("TR1.s1", "New", List.of());
        dropSwappedMark();
        recovery.recover(journalDir());
        assertEquals("Old", read(f).getString(Tag.SeriesDescription));
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 復旧_索引の列を触らない編集は_印があれば確定() throws Exception {
        ingest("TR2.st", "TR2.se", "TR2.s1", "Old", 1);
        Path f = crashAfterSwap("TR2.s1", "New", List.of());
        recovery.recover(journalDir());
        assertEquals("New", read(f).getString(Tag.SeriesDescription));
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 復旧_索引の列を触る編集は_索引が編集前なら戻し_編集後なら残す() throws Exception {
        ingest("TR3.st", "TR3.se", "TR3.s1", "Old", 1);
        Path f = crashAfterSwap("TR3.s1", "New", List.of(IndexedTag.SERIES_DESCRIPTION));
        recovery.recover(journalDir());
        assertEquals("Old", read(f).getString(Tag.SeriesDescription), "DB は巻き戻っていた");
        assertEquals(List.of(), leftovers());

        ingest("TR4.st", "TR4.se", "TR4.s1", "Old", 2);
        Path g = crashAfterSwap("TR4.s1", "New", List.of(IndexedTag.SERIES_DESCRIPTION));
        DicomInstance row = repo.findById("TR4.s1").orElseThrow();
        row.setSeriesDescription("New");
        repo.save(row);
        recovery.recover(journalDir());
        assertEquals("New", read(g).getString(Tag.SeriesDescription), "DB はコミットされていた");
        assertEquals(List.of(), leftovers());
    }
}
