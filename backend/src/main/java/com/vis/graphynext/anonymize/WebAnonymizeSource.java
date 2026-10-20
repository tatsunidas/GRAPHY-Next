/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * web: PACS（QIDO-RS で一覧、WADO-RS で 1 枚）から読む。1 枚ずつ取り、ビューアのキャッシュを通さない。
 *
 * <p>取った Part-10 は一時ファイルに落として {@link IncludeBulkData#URI} で読む。圧縮画素の伸長が
 * BulkData 参照を要求するため（{@link LocalAnonymizeSource} と同じ読み方にそろえる）。
 * 一時ファイルは {@link Opened#close()} で消える。
 */
public class WebAnonymizeSource implements AnonymizeSource {

    private final WebDicomDataService web;
    private final List<String> studyUids;
    private final Path tempDir;
    private List<Item> items;

    public WebAnonymizeSource(WebDicomDataService web, List<String> studyUids, Path tempDir) {
        this.web = web;
        this.studyUids = studyUids;
        this.tempDir = tempDir;
    }

    @Override
    public List<Item> list() {
        if (items != null) {
            return items;
        }
        List<Item> out = new ArrayList<>();
        for (String su : studyUids) {
            if (su == null || su.isBlank()) {
                continue;
            }
            String patientId = patientIdOf(su);
            for (Attributes a : web.searchStudyInstances(su, Map.of())) {
                String sop = a.getString(Tag.SOPInstanceUID);
                String series = a.getString(Tag.SeriesInstanceUID);
                if (sop == null || series == null) {
                    continue;
                }
                out.add(new Item(su, series, sop, patientId));
            }
        }
        items = out;
        return out;
    }

    private String patientIdOf(String studyUid) {
        for (Attributes s : web.searchStudies(Map.of("StudyInstanceUID", studyUid))) {
            if (studyUid.equals(s.getString(Tag.StudyInstanceUID))) {
                String pid = s.getString(Tag.PatientID);
                return pid == null ? "" : pid;
            }
        }
        return "";
    }

    @Override
    public Opened open(Item item) throws IOException {
        byte[] part10;
        try {
            part10 = web.fetchInstanceUncached(item.studyUid(), item.seriesUid(), item.sopUid());
        } catch (RuntimeException e) {
            throw new Missing("PACS から取得できません: " + item.sopUid() + " (" + e.getMessage() + ")");
        }
        Files.createDirectories(tempDir);
        Path tmp = Files.createTempFile(tempDir, "anon-", ".dcm");
        try {
            Files.write(tmp, part10);
            try (DicomInputStream in = new DicomInputStream(tmp.toFile())) {
                in.setIncludeBulkData(IncludeBulkData.URI);
                in.readFileMetaInformation();
                Attributes ds = in.readDataset(-1, -1);
                return new Opened(ds, in.getTransferSyntax(), () -> Files.deleteIfExists(tmp));
            }
        } catch (IOException | RuntimeException e) {
            Files.deleteIfExists(tmp);
            throw e;
        }
    }
}
