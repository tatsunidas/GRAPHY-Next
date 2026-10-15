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
import java.util.Objects;
import java.util.stream.Stream;

/**
 * 患者編集（{@link PatientFileEdit}）の途中でプロセスが落ちたときの後始末。起動時に journal を読み、
 * 各ファイルの<b>患者タグが索引と合っているほう</b>を残す（索引が新しい値ならファイルも新しい値、古い値なら退避した元へ戻す）。
 * どちらとも合わないものは、データを失わないよう何も消さずに警告だけ残す。
 */
@Component
public class PatientEditRecovery {

    private static final Logger log = LoggerFactory.getLogger(PatientEditRecovery.class);

    private final StorageLayout layout;
    private final DicomInstanceRepository repo;

    public PatientEditRecovery(StorageLayout layout, DicomInstanceRepository repo) {
        this.layout = layout;
        this.repo = repo;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        try {
            recover(layout.root().resolve(".edit-journal"));
        } catch (RuntimeException e) {
            log.warn("患者編集の復旧に失敗（起動は続ける）", e);
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

    /** 全項目を片付けられたら true（journal を消してよい）。 */
    private boolean recoverOne(Path journal) throws IOException {
        boolean allDone = true;
        for (String line : Files.readAllLines(journal, StandardCharsets.UTF_8)) {
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
                allDone &= recoverFile(sop, file);
            } catch (IOException | RuntimeException e) {
                allDone = false;
                log.warn("患者編集の復旧に失敗: sop={}", sop, e);
            }
        }
        return allDone;
    }

    private boolean recoverFile(String sop, Path file) throws IOException {
        Path orig = PatientFileEdit.origName(file);
        Path edit = PatientFileEdit.editName(file);
        Files.deleteIfExists(edit); // 作りかけの一時ファイルは常に不要
        if (!Files.exists(orig)) {
            return true; // 入れ替えに至らなかった、または確定済み
        }
        if (!Files.exists(file)) {
            Files.move(orig, file, StandardCopyOption.REPLACE_EXISTING); // 退避だけが残っている
            log.warn("患者編集の途中で止まっていたため、元のファイルを戻しました: sop={}", sop);
            return true;
        }
        DicomInstance row = repo.findById(sop).orElse(null);
        if (row == null) {
            log.warn("索引に無いため判断できません。退避を残します: {}", orig);
            return false;
        }
        if (Objects.equals(tags(file), rowTags(row))) {
            Files.deleteIfExists(orig); // 索引と合っている＝確定していた
            return true;
        }
        if (Objects.equals(tags(orig), rowTags(row))) {
            Files.move(orig, file, StandardCopyOption.REPLACE_EXISTING); // 索引は編集前＝取り消されていた
            log.warn("患者編集が確定していなかったため、元のファイルへ戻しました: sop={}", sop);
            return true;
        }
        log.warn("ファイルと退避のどちらも索引と合いません。何も消さずに残します: {}", file);
        return false;
    }

    private record Tags(String name, String birthDate, String sex, String id) {
    }

    private static String n(String s) {
        return s == null ? "" : s;
    }

    private static Tags rowTags(DicomInstance r) {
        return new Tags(n(r.getPatientName()), n(r.getPatientBirthDate()), n(r.getPatientSex()), n(r.getPatientId()));
    }

    private static Tags tags(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            Attributes a = in.readDataset(-1, Tag.PixelData);
            return new Tags(n(a.getString(Tag.PatientName)), n(a.getString(Tag.PatientBirthDate)),
                    n(a.getString(Tag.PatientSex)), n(a.getString(Tag.PatientID)));
        }
    }
}
