/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 複数の DICOM ファイルの書き換えを<b>全か無か</b>にする（患者情報の編集・タグの編集）。
 *
 * <ol>
 *   <li>{@link #prepare}: すべてのファイルの新しい内容を、走査・同期に見えない一時ファイル（{@code .<名前>.edit}）へ書く。
 *       1 つでも失敗したら一時ファイルを全部消して中止する（元のファイルは 1 つも触っていない）。</li>
 *   <li>{@link #swap}: 各ファイルを {@code 元 → .<名前>.orig}（退避）、{@code 一時 → 元} の順にリネームする。
 *       途中で失敗したら、入れ替え済みのものを退避から戻してから失敗にする。</li>
 *   <li>呼び出し側が DB を更新する。失敗したら {@link #rollback}（元に戻す）、成功したら {@link #commit}（退避を消す）。</li>
 * </ol>
 *
 * <p>入れ替え（2 番）の前に {@code <journalDir>/<id>.journal} を書き、完了で消す。入れ替えの途中や DB 更新の途中で
 * プロセスが落ちても、起動時に {@link DicomEditRecovery} が索引と突き合わせて整合を戻せるようにするため。
 *
 * <p>失敗した操作の遅い部分（取り寄せ・リトライの待ち）は準備のあいだに済ませ、DB への書き込みは最後に短く行う
 * （DB の書き込みロックを握ったまま待たない）。
 */
final class DicomFileEdit {

    private static final Logger log = LoggerFactory.getLogger(DicomFileEdit.class);

    /**
     * 編集の種類。失敗の文言の接頭辞と、journal の 1 行目（起動時の復旧が判定のしかたを選ぶ）に使う。
     * タグの編集は、触った索引の列（{@link IndexedTag} の名前）を journal に残す。
     */
    record Kind(String failPrefix, String journalHeader) {
        static final Kind PATIENT = new Kind("patient-edit-failed", "#kind\tpatient");

        static Kind tags(java.util.Collection<IndexedTag> indexColumns) {
            return new Kind("tag-edit-failed", "#kind\ttags\t"
                    + String.join(",", indexColumns.stream().map(Enum::name).toList()));
        }
    }

    /** 入れ替えをすべて終えた印（journal の末尾）。タグの編集の復旧は、これが無ければ元へ戻す。 */
    static final String SWAPPED_MARK = "#swapped";

    /** 失敗した（編集全体を取り消す）。{@code sop} は失敗したファイルの SOP UID（患者情報は含めない）。 */
    static final class EditFailedException extends RuntimeException {
        private final String sop;

        EditFailedException(Kind kind, String sop, String phase, Throwable cause) {
            super(kind.failPrefix() + ": " + phase + " sop=" + sop + " (" + cause.getClass().getSimpleName() + ")", cause);
            this.sop = sop;
        }

        String sop() {
            return sop;
        }
    }

    /** ファイル操作（テストで失敗を注入できるように分けてある）。 */
    interface Ops {
        void move(Path from, Path to) throws IOException;

        void delete(Path p) throws IOException;

        Ops REAL = new Ops() {
            @Override
            public void move(Path from, Path to) throws IOException {
                Files.move(from, to, StandardCopyOption.REPLACE_EXISTING);
            }

            @Override
            public void delete(Path p) throws IOException {
                Files.deleteIfExists(p);
            }
        };
    }

    /** {@code source} を読んで、書き換えた内容を {@code target} に書く。 */
    interface Writer {
        void write(Path source, Path target) throws IOException;
    }

    record Target(String sop, Path file) {
    }

    private record Item(String sop, Path file, Path edit, Path orig) {
    }

    private final List<Item> items = new ArrayList<>();
    private final List<Item> swapped = new ArrayList<>();
    private final Path journalDir;
    private final FileRetry retry;
    private final Ops ops;
    private final Kind kind;
    private Path journal;
    private boolean finished;

    private DicomFileEdit(Path journalDir, FileRetry retry, Ops ops, Kind kind) {
        this.journalDir = journalDir;
        this.retry = retry;
        this.ops = ops;
        this.kind = kind;
    }

    static Path editName(Path file) {
        return file.resolveSibling("." + file.getFileName() + ".edit");
    }

    static Path origName(Path file) {
        return file.resolveSibling("." + file.getFileName() + ".orig");
    }

    static DicomFileEdit prepare(List<Target> targets, Writer writer, Path journalDir, FileRetry retry, Ops ops) {
        return prepare(targets, writer, journalDir, retry, ops, Kind.PATIENT);
    }

    static DicomFileEdit prepare(List<Target> targets, Writer writer, Path journalDir, FileRetry retry, Ops ops,
                                 Kind kind) {
        DicomFileEdit e = new DicomFileEdit(journalDir, retry, ops, kind);
        for (Target t : targets) {
            Item it = new Item(t.sop(), t.file(), editName(t.file()), origName(t.file()));
            e.items.add(it);
            try {
                retry.run("書き換えの準備 " + t.sop(), t.file(), () -> {
                    writer.write(it.file(), it.edit());
                    return null;
                });
            } catch (IOException | RuntimeException ex) {
                e.cleanupEdits();
                throw new EditFailedException(kind, t.sop(), "prepare", ex);
            }
        }
        return e;
    }

    boolean isEmpty() {
        return items.isEmpty();
    }

    List<Path> files() {
        return items.stream().map(Item::file).toList();
    }

    /** 元のファイルを退避し、新しい内容を元の名前へ置く。失敗したら戻して例外。 */
    void swap() {
        writeJournal();
        for (Item it : items) {
            try {
                retry.run("退避 " + it.sop(), it.file(), () -> {
                    ops.move(it.file(), it.orig());
                    return null;
                });
                swapped.add(it);
                retry.run("入れ替え " + it.sop(), it.edit(), () -> {
                    ops.move(it.edit(), it.file());
                    return null;
                });
            } catch (IOException | RuntimeException ex) {
                rollback();
                throw new EditFailedException(kind, it.sop(), "swap", ex);
            }
        }
        try {
            Files.writeString(journal, SWAPPED_MARK + "\n", StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.APPEND);
        } catch (IOException ex) {
            rollback();
            throw new EditFailedException(kind, items.isEmpty() ? "-" : items.get(0).sop(), "journal", ex);
        }
    }

    /** 元に戻す（何度呼んでも安全。入れ替え前なら一時ファイルを消すだけ）。 */
    void rollback() {
        if (finished) {
            return;
        }
        finished = true;
        for (int i = swapped.size() - 1; i >= 0; i--) {
            Item it = swapped.get(i);
            try {
                // 退避した元を戻す。入れ替え前に失敗した項目は file が無い、入れ替え後なら新しい内容がある（上書きで戻す）
                if (Files.exists(it.orig())) {
                    retry.run("復元 " + it.sop(), it.orig(), () -> {
                        ops.move(it.orig(), it.file());
                        return null;
                    });
                }
            } catch (IOException | RuntimeException ex) {
                // 戻せなかった。退避は消さずに残し（データを失わない）、journal も残して起動時の復旧に任せる
                log.error("編集の巻き戻しに失敗: {} 退避 {} を残す", it.file(), it.orig(), ex);
                return;
            }
        }
        cleanupEdits();
        deleteJournal();
    }

    /** 確定する（退避を消す）。 */
    void commit() {
        if (finished) {
            return;
        }
        finished = true;
        for (Item it : swapped) {
            try {
                ops.delete(it.orig());
            } catch (IOException ex) {
                log.warn("退避の削除に失敗（残骸は起動時に片付く）: {}", it.orig(), ex);
                return; // journal を残す
            }
        }
        deleteJournal();
    }

    private void cleanupEdits() {
        for (Item it : items) {
            try {
                ops.delete(it.edit());
            } catch (IOException ex) {
                log.warn("一時ファイルの削除に失敗: {}", it.edit(), ex);
            }
        }
    }

    private void writeJournal() {
        try {
            Files.createDirectories(journalDir);
            journal = journalDir.resolve(UUID.randomUUID() + ".journal");
            StringBuilder sb = new StringBuilder(kind.journalHeader()).append('\n');
            for (Item it : items) {
                sb.append(it.sop()).append('\t').append(it.file().toAbsolutePath()).append('\n');
            }
            Files.writeString(journal, sb.toString(), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            cleanupEdits();
            throw new EditFailedException(kind, items.isEmpty() ? "-" : items.get(0).sop(), "journal", ex);
        }
    }

    private void deleteJournal() {
        if (journal != null) {
            try {
                Files.deleteIfExists(journal);
            } catch (IOException ex) {
                log.warn("journal の削除に失敗: {}", journal, ex);
            }
        }
    }
}
