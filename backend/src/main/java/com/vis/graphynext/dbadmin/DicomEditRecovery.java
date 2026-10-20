/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.stream.Stream;

/**
 * ファイルの編集（{@link DicomFileEdit}）の途中でプロセスが落ちたときの後始末。起動時に journal を読み、種類ごとに判定する。
 * <ul>
 *   <li>患者情報の編集（1 行目が無い古い journal も含む）: 各ファイルの<b>患者タグが索引と合っているほう</b>を残す
 *       （索引が新しい値ならファイルも新しい値、古い値なら退避した元へ戻す）。</li>
 *   <li>タグの編集: 入れ替えを終えた印（{@link DicomFileEdit#SWAPPED_MARK}）が無ければ、全ファイルを元へ戻す
 *       （索引に写しの無いタグは、索引と突き合わせて決められないため）。印があれば、触った索引の列が合っているほうを残す。
 *       索引の列を触っていない編集は DB に書くものが無いので、印があれば確定とする。</li>
 * </ul>
 * どちらとも合わないものは、データを失わないよう何も消さずに警告だけ残す。
 */
@Component
public class DicomEditRecovery {

    private static final Logger log = LoggerFactory.getLogger(DicomEditRecovery.class);

    private final StorageLayout layout;
    private final DicomInstanceRepository repo;

    public DicomEditRecovery(StorageLayout layout, DicomInstanceRepository repo) {
        this.layout = layout;
        this.repo = repo;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        try {
            recover(layout.root().resolve(".edit-journal"));
        } catch (RuntimeException e) {
            log.warn("編集の復旧に失敗（起動は続ける）", e);
        }
    }

    /** テストから呼ぶ。journal を全て処理する。 */
    void recover(Path journalDir) {
        if (!Files.isDirectory(journalDir)) {
            return;
        }
        try (Stream<Path> js = Files.list(journalDir)) {
            for (Path j : js.filter(p -> p.getFileName().toString().endsWith(".journal")).toList()) {
                if (recoverOne(j)) {
                    Files.deleteIfExists(j);
                }
            }
        } catch (IOException e) {
            log.warn("journal を読めません: {}", journalDir, e);
        }
    }

    /** journal の 1 行目から決まる判定のしかた。tags は触った索引の列。 */
    private record Mode(boolean patient, List<IndexedTag> tags, boolean swapped) {
    }

    /** 全項目を片付けられたら true（journal を消してよい）。 */
    private boolean recoverOne(Path journal) throws IOException {
        List<String> lines = Files.readAllLines(journal, StandardCharsets.UTF_8);
        Mode mode = mode(lines);
        boolean allDone = true;
        for (String line : lines) {
            if (line.startsWith("#")) {
                continue;
            }
            int tab = line.indexOf('\t');
            if (tab <= 0) {
                continue;
            }
            String sop = line.substring(0, tab);
            Path file = Path.of(line.substring(tab + 1));
            if (!file.normalize().startsWith(layout.root())) {
                allDone = false;
                log.warn("journal の項目が保管庫の外を指しています（無視）: {}", file);
                continue;
            }
            try {
                allDone &= recoverFile(sop, file, mode);
            } catch (IOException | RuntimeException e) {
                allDone = false;
                log.warn("編集の復旧に失敗: sop={}", sop, e);
            }
        }
        return allDone;
    }

    private static Mode mode(List<String> lines) {
        boolean swapped = lines.contains(DicomFileEdit.SWAPPED_MARK);
        if (lines.isEmpty() || !lines.get(0).startsWith("#kind\t")) {
            return new Mode(true, List.of(), swapped);
        }
        String[] f = lines.get(0).split("\t", -1);
        if (f.length >= 2 && f[1].equals("tags")) {
            List<IndexedTag> cols = new ArrayList<>();
            if (f.length >= 3) {
                for (String c : f[2].split(",")) {
                    if (!c.isBlank()) {
                        cols.add(IndexedTag.valueOf(c));
                    }
                }
            }
            return new Mode(false, cols, swapped);
        }
        return new Mode(true, List.of(), swapped);
    }

    private boolean recoverFile(String sop, Path file, Mode mode) throws IOException {
        Path orig = DicomFileEdit.origName(file);
        Path edit = DicomFileEdit.editName(file);
        Files.deleteIfExists(edit); // 作りかけの一時ファイルは常に不要
        if (!Files.exists(orig)) {
            return true; // 入れ替えに至らなかった、または確定済み
        }
        if (!Files.exists(file)) {
            Files.move(orig, file, StandardCopyOption.REPLACE_EXISTING); // 退避だけが残っている
            log.warn("編集の途中で止まっていたため、元のファイルを戻しました: sop={}", sop);
            return true;
        }
        if (!mode.patient()) {
            if (!mode.swapped()) {
                Files.move(orig, file, StandardCopyOption.REPLACE_EXISTING); // 入れ替えの途中で落ちた＝確定していない
                log.warn("タグの編集が入れ替えの途中で止まっていたため、元のファイルへ戻しました: sop={}", sop);
                return true;
            }
            if (mode.tags().isEmpty()) {
                Files.deleteIfExists(orig); // 索引に書くものが無い編集で、入れ替えは済んでいた
                return true;
            }
        }
        DicomInstance row = repo.findById(sop).orElse(null);
        if (row == null) {
            log.warn("索引に無いため判断できません。退避を残します: {}", orig);
            return false;
        }
        if (matchesIndex(file, row, mode)) {
            Files.deleteIfExists(orig); // 索引と合っている＝確定していた
            return true;
        }
        if (matchesIndex(orig, row, mode)) {
            Files.move(orig, file, StandardCopyOption.REPLACE_EXISTING); // 索引は編集前＝取り消されていた
            log.warn("編集が確定していなかったため、元のファイルへ戻しました: sop={}", sop);
            return true;
        }
        log.warn("ファイルと退避のどちらも索引と合いません。何も消さずに残します: {}", file);
        return false;
    }

    private static boolean matchesIndex(Path f, DicomInstance row, Mode mode) throws IOException {
        Attributes a;
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            a = in.readDataset(-1, Tag.PixelData);
        }
        if (mode.patient()) {
            return Objects.equals(tags(a), rowTags(row));
        }
        for (IndexedTag t : mode.tags()) {
            if (!t.matches(row, a)) {
                return false;
            }
        }
        return true;
    }

    private record Tags(String name, String birthDate, String sex, String id) {
    }

    private static String n(String s) {
        return s == null ? "" : s;
    }

    private static Tags rowTags(DicomInstance r) {
        return new Tags(n(r.getPatientName()), n(r.getPatientBirthDate()), n(r.getPatientSex()), n(r.getPatientId()));
    }

    private static Tags tags(Attributes a) {
        return new Tags(n(a.getString(Tag.PatientName)), n(a.getString(Tag.PatientBirthDate)),
                n(a.getString(Tag.PatientSex)), n(a.getString(Tag.PatientID)));
    }
}
