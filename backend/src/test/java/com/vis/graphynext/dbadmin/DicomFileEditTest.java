/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「全か無か」の入れ替え。失敗は準備・入れ替え・確定のどこで起きても、元のファイルは 1 つも失われず、
 * 一時ファイル・退避・journal が残らない。
 */
class DicomFileEditTest {

    @TempDir
    Path root;

    final FileRetry noWait = new FileRetry(ms -> { });

    private Path file(String name, String content) throws IOException {
        Path f = root.resolve(name);
        Files.writeString(f, content);
        return f;
    }

    private static String read(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    /** 内容の末尾に "+new" を足すだけの書き手。{@code failOn} に当たるファイル名は失敗させる。 */
    private DicomFileEdit.Writer writer(String failOn) {
        return (src, dst) -> {
            if (failOn != null && src.getFileName().toString().equals(failOn)) {
                throw new IOException("DICOM として読めない: " + src.getFileName());
            }
            Files.writeString(dst, Files.readString(src) + "+new");
        };
    }

    private List<String> leftovers() throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(Files::isRegularFile).map(p -> root.relativize(p).toString()).map(n -> n.replace(java.io.File.separatorChar, '/'))
                    .filter(n -> n.contains(".edit") || n.contains(".orig") || n.endsWith(".journal")).sorted().toList();
        }
    }

    private List<DicomFileEdit.Target> targets(Path... files) {
        return java.util.Arrays.stream(files).map(f -> new DicomFileEdit.Target("sop-" + f.getFileName(), f)).toList();
    }

    @Test
    void 成功_全ファイルが新しい内容になり_確定で退避が消える() throws Exception {
        Path a = file("a.dcm", "A");
        Path b = file("b.dcm", "B");
        DicomFileEdit e = DicomFileEdit.prepare(targets(a, b), writer(null), root.resolve("j"), noWait, DicomFileEdit.Ops.REAL);
        e.swap();
        assertEquals("A+new", read(a));
        assertEquals("B+new", read(b));
        assertEquals(List.of(".a.dcm.orig", ".b.dcm.orig", "j/" + onlyJournal()), leftovers(), "確定前は退避と journal がある");
        e.commit();
        assertEquals(List.of(), leftovers());
        assertEquals("A+new", read(a));
    }

    private String onlyJournal() throws IOException {
        try (Stream<Path> s = Files.list(root.resolve("j"))) {
            return s.findFirst().orElseThrow().getFileName().toString();
        }
    }

    @Test
    void 準備で2つ目が失敗_元のファイルは1つも変わらず_一時ファイルも残らない() throws Exception {
        Path a = file("a.dcm", "A");
        Path b = file("b.dcm", "B");
        Path c = file("c.dcm", "C");
        var ex = assertThrows(DicomFileEdit.EditFailedException.class, () ->
                DicomFileEdit.prepare(targets(a, b, c), writer("b.dcm"), root.resolve("j"), noWait, DicomFileEdit.Ops.REAL));
        assertEquals("sop-b.dcm", ex.sop());
        assertEquals("A", read(a));
        assertEquals("B", read(b));
        assertEquals("C", read(c));
        assertEquals(List.of(), leftovers(), "1 つ目の一時ファイルも消える");
    }

    /** 失敗を注入する Ops: n 回目の move で失敗する（以降は通常）。 */
    private static DicomFileEdit.Ops failingMove(int failAt, boolean permanent) {
        int[] n = {0};
        return new DicomFileEdit.Ops() {
            @Override public void move(Path from, Path to) throws IOException {
                n[0]++;
                if (n[0] == failAt) {
                    throw permanent ? new java.nio.file.NoSuchFileException(from.toString()) : new AccessDeniedException(from.toString());
                }
                DicomFileEdit.Ops.REAL.move(from, to);
            }

            @Override public void delete(Path p) throws IOException {
                DicomFileEdit.Ops.REAL.delete(p);
            }
        };
    }

    @Test
    void 入れ替えで2つ目が失敗_入れ替え済みの1つ目も元に戻る() throws Exception {
        Path a = file("a.dcm", "A");
        Path b = file("b.dcm", "B");
        // move: 1=a 退避, 2=a 入れ替え, 3=b 退避（ここで永続エラー）
        DicomFileEdit e = DicomFileEdit.prepare(targets(a, b), writer(null), root.resolve("j"), noWait, failingMove(3, true));
        var ex = assertThrows(DicomFileEdit.EditFailedException.class, e::swap);
        assertEquals("sop-b.dcm", ex.sop());
        assertEquals("A", read(a), "入れ替え済みだった a も元の内容へ戻る");
        assertEquals("B", read(b));
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 入れ替えの一時的な失敗は_リトライで乗り切って成功する() throws Exception {
        Path a = file("a.dcm", "A");
        // 退避（1 回目）が一時的に失敗 → やり直して成功
        DicomFileEdit e = DicomFileEdit.prepare(targets(a), writer(null), root.resolve("j"), noWait, failingMove(1, false));
        e.swap();
        assertEquals("A+new", read(a));
        e.commit();
        assertEquals(List.of(), leftovers());
    }

    @Test
    void DB更新の失敗を想定した巻き戻し_全ファイルが元の内容に戻り_何も残らない() throws Exception {
        Path a = file("a.dcm", "A");
        Path b = file("b.dcm", "B");
        DicomFileEdit e = DicomFileEdit.prepare(targets(a, b), writer(null), root.resolve("j"), noWait, DicomFileEdit.Ops.REAL);
        e.swap();
        e.rollback();
        assertEquals("A", read(a));
        assertEquals("B", read(b));
        assertEquals(List.of(), leftovers());
        e.rollback(); // 二重に呼んでも安全
        e.commit();   // 巻き戻し後の確定は何もしない
        assertEquals("A", read(a));
    }

    @Test
    void 巻き戻し自体が失敗したら_退避と_journal_を残す_データを失わない() throws Exception {
        Path a = file("a.dcm", "A");
        DicomFileEdit e = DicomFileEdit.prepare(targets(a), writer(null), root.resolve("j"),
                noWait, new DicomFileEdit.Ops() {
                    int n;
                    @Override public void move(Path from, Path to) throws IOException {
                        if (++n == 3) { // 1=退避 2=入れ替え 3=復元（rollback）
                            throw new java.nio.file.NoSuchFileException("x");
                        }
                        DicomFileEdit.Ops.REAL.move(from, to);
                    }
                    @Override public void delete(Path p) throws IOException { DicomFileEdit.Ops.REAL.delete(p); }
                });
        e.swap();
        e.rollback();
        assertTrue(Files.exists(root.resolve(".a.dcm.orig")), "元の内容は退避に残る");
        assertEquals("A", read(root.resolve(".a.dcm.orig")));
        assertTrue(Files.exists(root.resolve("j")) && Files.list(root.resolve("j")).findAny().isPresent(), "起動時の復旧用に journal を残す");
    }

    @Test
    void 一時ファイルと退避は_走査に見えない名前() throws Exception {
        Path a = file("a.dcm", "A");
        assertTrue(DicomFileEdit.editName(a).getFileName().toString().startsWith("."));
        assertTrue(DicomFileEdit.origName(a).getFileName().toString().startsWith("."));
        assertFalse(DicomFileEdit.editName(a).getFileName().toString().contains("~"));
    }
}
