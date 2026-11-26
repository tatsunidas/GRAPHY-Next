/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.plugin.store.PluginDocument;
import com.vis.graphynext.plugin.store.PluginDocumentId;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.ToLongFunction;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 外付けの荷物を今の DB に取り込む。荷物は「移し元」の機能で作り、移し元の行を消してから取り込む。
 * 負例は、同じ作り方の荷物を 1 か所だけ壊して「何も取り込まない」ことを見る（壊さない正例は先頭のテスト）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:extimport;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false",
        "GRAPHY_MAIN_SECRET=" + ExternalImportTest.SECRET
})
@AutoConfigureMockMvc
class ExternalImportTest {

    static final String SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.db.folder", () -> tmp.resolve("db").toString());
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("db/dicom").toString());
        r.add("graphy.plugins.dir", () -> tmp.resolve("plugins").toString());
    }

    @Autowired
    ExternalPackageImport imports;
    @Autowired
    InboxIngestService inbox;
    @Autowired
    DbTransferService transfer;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;
    @Autowired
    PluginDocumentRepository pluginDocs;
    @Autowired
    SettingsService settings;
    @Autowired
    TransactionTemplate tx;
    @Autowired
    MockMvc mvc;

    private final ObjectMapper mapper = new ObjectMapper();
    private Path drive;

    @BeforeEach
    void drive() throws IOException {
        Files.createDirectories(tmp.resolve("db"));
        drive = tmp.resolve("外付け " + UUID.randomUUID());
        Files.createDirectories(drive);
    }

    private Path dicom(String pid, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        return DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
    }

    /** 検査 1 件（画像 2 枚と記録）を書き出し、移し元から消す。返すのは荷物のフォルダ。 */
    private Path exportAndForget(String tag) throws Exception {
        String pid = "P-" + tag, study = tag + ".st", series = tag + ".se";
        storage.ingest(dicom(pid, study, series, tag + ".1"));
        storage.ingest(dicom(pid, study, series, tag + ".2"));
        pluginDocs.save(new PluginDocument("demo", pid, "{\"tag\":\"" + tag + "\"}"));
        var r = transfer.transfer(List.of(study), drive.toString(), DbTransferService.Mode.copy);
        tx.executeWithoutResult(s -> {
            repo.deleteAll(repo.findByStudyInstanceUid(study));
            pluginDocs.deleteById(new PluginDocumentId("demo", pid));
        });
        return drive.resolve("inbox").resolve(r.id());
    }

    private static List<String> snapshot(Path root) throws IOException {
        List<String> out = new ArrayList<>();
        try (Stream<Path> s = Files.walk(root)) {
            for (Path p : s.sorted().toList()) {
                out.add(root.relativize(p) + (Files.isDirectory(p) ? "/" : " " + Files.size(p) + " "
                        + DbTransferService.sha256(p) + " " + Files.getLastModifiedTime(p)));
            }
        }
        return out;
    }

    private ExternalPackageImport.JobStatus run(Path folder) throws Exception {
        String job = imports.start(folder.toString());
        long end = System.currentTimeMillis() + 30_000;
        while (imports.status(job).state().equals("running")) {
            assertTrue(System.currentTimeMillis() < end, "終わらない");
            Thread.sleep(20);
        }
        return imports.status(job);
    }

    private void editManifest(Path pkg, Consumer<ObjectNode> edit) throws IOException {
        ObjectNode t = (ObjectNode) mapper.readTree(pkg.resolve("manifest.json").toFile());
        edit.accept(t);
        mapper.writeValue(pkg.resolve("manifest.json").toFile(), t);
    }

    private Path firstFile(Path pkg) throws IOException {
        return pkg.resolve(mapper.readTree(pkg.resolve("manifest.json").toFile()).at("/files/0/path").asText());
    }

    /** 壊した荷物は、画像も記録も 1 件も入らず、手元に書きかけも残らない。 */
    private void assertNothingImported(String tag, String outcome) throws Exception {
        var s = run(drive);
        assertEquals("done", s.state());
        assertEquals(List.of(outcome), s.packages().stream().map(ExternalPackageImport.ImportedPackage::outcome).toList());
        assertEquals(List.of(), s.studyUids());
        assertTrue(repo.findByStudyInstanceUid(tag + ".st").isEmpty());
        assertTrue(pluginDocs.findById(new PluginDocumentId("demo", "P-" + tag)).isEmpty());
        assertNoPartial();
    }

    private void assertNoPartial() throws IOException {
        Path in = tmp.resolve("db/inbox");
        if (Files.exists(in)) {
            try (Stream<Path> s = Files.list(in)) {
                assertEquals(List.of(), s.filter(p -> p.toString().endsWith(".partial")).toList());
            }
        }
    }

    @Test
    void 取り込める_取り込み元は変えない_2回目は何も足さない() throws Exception {
        exportAndForget("ok");
        List<String> before = snapshot(drive);

        var scan = imports.scan(drive.toString());
        assertEquals(1, scan.packages().size());
        assertEquals(2, scan.packages().get(0).files());
        assertTrue(scan.enoughSpace());
        assertEquals("missing", scan.packages().get(0).pluginNotes().get(0).kind());
        assertTrue(repo.findByStudyInstanceUid("ok.st").isEmpty(), "scan は取り込まない");

        var s = run(drive);
        assertEquals("done", s.state());
        assertEquals("imported", s.packages().get(0).outcome());
        assertEquals(2, s.packages().get(0).result().imported());
        assertEquals(0, s.packages().get(0).result().failed());
        assertEquals(List.of("ok.st"), s.studyUids());
        assertEquals(2, repo.findByStudyInstanceUid("ok.st").size());
        assertEquals("{\"tag\":\"ok\"}",
                pluginDocs.findById(new PluginDocumentId("demo", "P-ok")).orElseThrow().getJson());
        assertEquals(before, snapshot(drive), "取り込み元は一覧・中身・更新時刻とも変わらない");
        assertNoPartial();
        assertEquals(0, inbox.activeCount());

        var again = run(drive).packages().get(0).result();
        assertEquals(0, again.imported());
        assertEquals(2, again.skippedExisting());
        assertEquals(0, again.relatedInserted());
        assertEquals(1, again.relatedSame());
        assertEquals(before, snapshot(drive));
    }

    @Test
    void 荷物のフォルダを直接選んでも取り込める_複数の荷物はまとめて取り込む() throws Exception {
        Path a = exportAndForget("dir-a");
        assertEquals(1, run(a).packages().size());
        assertEquals(2, repo.findByStudyInstanceUid("dir-a.st").size());
        exportAndForget("dir-b");
        var s = run(drive);
        assertEquals(2, s.packages().size());
        assertEquals(2, repo.findByStudyInstanceUid("dir-b.st").size());
    }

    @Test
    void 改ざんは何も取り込まない() throws Exception {
        Path f = firstFile(exportAndForget("tamper"));
        byte[] b = Files.readAllBytes(f);
        b[b.length - 1] ^= 1;
        Files.write(f, b);
        assertNothingImported("tamper", "damaged");
    }

    @Test
    void 欠けは何も取り込まない() throws Exception {
        Files.delete(firstFile(exportAndForget("lack")));
        assertNothingImported("lack", "incomplete");
    }

    @Test
    void 目録のSOP_UIDが中身と違えば取り込まず_既存の画像を置き換えない() throws Exception {
        // 手元にある別の画像（victim）と同じ SOP UID を持つ中身を、目録では別の UID として載せる
        storage.ingest(dicom("V", "victim.st", "victim.se", "victim.1"));
        var victim = repo.findById("victim.1").orElseThrow();
        String victimSha = DbTransferService.sha256(layout.resolveForRead(victim));
        Path pkg = exportAndForget("spoof");
        Path f = firstFile(pkg);
        Files.copy(dicom("ATTACK", "attack.st", "attack.se", "victim.1"), f, StandardCopyOption.REPLACE_EXISTING);
        long size = Files.size(f);
        String sha = DbTransferService.sha256(f);
        editManifest(pkg, t -> ((ObjectNode) t.get("files").get(0)).put("size", size).put("sha256", sha));

        assertNothingImported("spoof", "damaged");
        assertEquals("victim.st", repo.findById("victim.1").orElseThrow().getStudyInstanceUid());
        assertEquals(victimSha, DbTransferService.sha256(layout.resolveForRead(repo.findById("victim.1").orElseThrow())));
    }

    @Test
    void 校正以外の設定のキーを含む荷物は受けない() throws Exception {
        Path pkg = exportAndForget("setting");
        editManifest(pkg, t -> ((ObjectNode) t.at("/related/calibrations")).put("plugins.installEnabled", "true"));
        String before = settings.getAll().get(SettingsService.PLUGIN_INSTALL_ENABLED_KEY);
        assertNothingImported("setting", "invalid-manifest");
        assertEquals(before, settings.getAll().get(SettingsService.PLUGIN_INSTALL_ENABLED_KEY));
    }

    @Test
    void id_やパスで荷物の外を指す目録は受けない() throws Exception {
        List<Consumer<ObjectNode>> edits = List.of(
                t -> t.put("id", "../../evil"),
                t -> ((ObjectNode) t.get("files").get(0)).put("path", "dicom/../../outside.dcm"),
                t -> ((ObjectNode) t.get("files").get(0)).put("path", "/etc/hostname"),
                t -> ((ArrayNode) t.at("/related/masks")).addObject().put("maskUid", "m").put("path", "masks/../x")
                        .put("size", 0).put("sha256", "0"));
        int n = 0;
        for (var edit : edits) {
            drive = Files.createDirectories(tmp.resolve("外付け-bad" + n));
            Path pkg = exportAndForget("bad" + n);
            editManifest(pkg, edit);
            assertNothingImported("bad" + n, "invalid-manifest");
            n++;
        }
    }

    @Test
    void 荷物の外を指すシンボリックリンクは取り込まない() throws Exception {
        Path f = firstFile(exportAndForget("link"));
        Path outside = tmp.resolve("outside.dcm");
        Files.move(f, outside); // 中身・サイズ・sha は目録どおりのまま、置き場だけ荷物の外
        try {
            Files.createSymbolicLink(f, outside);
        } catch (UnsupportedOperationException | IOException e) {
            org.junit.jupiter.api.Assumptions.abort("この環境ではシンボリックリンクを作れない");
        }
        assertNothingImported("link", "damaged");
    }

    @Test
    void 新しすぎる版は取り込まない() throws Exception {
        Path pkg = exportAndForget("new");
        editManifest(pkg, t -> t.put("formatVersion", TransferManifest.FORMAT_VERSION + 1));
        assertEquals("too-new", imports.scan(drive.toString()).packages().get(0).problem());
        assertNothingImported("new", "too-new");
    }

    @Test
    void 書きかけだけの荷物は数えるだけ() throws Exception {
        Path pkg = exportAndForget("part");
        Files.move(pkg, pkg.resolveSibling(pkg.getFileName() + ".partial"));
        var scan = imports.scan(drive.toString());
        assertEquals(0, scan.packages().size());
        assertEquals(1, scan.stalePartials());
        assertEquals(0, run(drive).packages().size());
        assertTrue(repo.findByStudyInstanceUid("part.st").isEmpty());
    }

    @Test
    void 容量が足りなければ始めない() throws Exception {
        exportAndForget("full");
        ToLongFunction<Path> real = imports.usableSpace;
        imports.usableSpace = p -> 1024;
        try {
            assertFalse(imports.scan(drive.toString()).enoughSpace());
            var e = assertThrows(IllegalArgumentException.class, () -> imports.start(drive.toString()));
            assertTrue(e.getMessage().startsWith("not-enough-space"), e.getMessage());
            assertTrue(repo.findByStudyInstanceUid("full.st").isEmpty());
        } finally {
            imports.usableSpace = real;
        }
    }

    @Test
    void 取り込み元のフォルダの検査() throws Exception {
        Files.createDirectories(tmp.resolve("empty"));
        for (var c : java.util.Map.of(
                tmp.resolve("db").toString(), "source-is-current",
                tmp.toString(), "source-is-current",
                tmp.resolve("empty").toString(), "no-packages",
                tmp.resolve("gone").toString(), "source-not-found",
                "relative/x", "source-not-absolute").entrySet()) {
            var e = assertThrows(IllegalArgumentException.class, () -> imports.scan(c.getKey()), c.getKey());
            assertEquals(c.getValue(), e.getMessage(), c.getKey());
        }
    }

    @Test
    void 口は_main_の秘密が無ければ見えない() throws Exception {
        exportAndForget("web");
        String body = mapper.writeValueAsString(java.util.Map.of("folder", drive.toString()));
        for (String url : new String[]{"/api/internal/db-transfer/import/scan", "/api/internal/db-transfer/import"}) {
            List<MockHttpServletRequestBuilder> refused = List.of(
                    post(url),
                    post(url).header("Authorization", "Bearer " + SECRET.replace('0', '1')),
                    post(url).header("Authorization", "Bearer " + SECRET).header("Origin", "http://localhost:5173"));
            for (var r : refused) {
                assertEquals(404, mvc.perform(r.contentType(MediaType.APPLICATION_JSON).content(body))
                        .andReturn().getResponse().getStatus(), url);
            }
        }
        assertEquals(404, mvc.perform(get("/api/internal/db-transfer/import/x")).andReturn().getResponse().getStatus());
        assertTrue(repo.findByStudyInstanceUid("web.st").isEmpty());
        assertEquals(200, mvc.perform(post("/api/internal/db-transfer/import/scan")
                .header("Authorization", "Bearer " + SECRET).contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse().getStatus());
    }
}
