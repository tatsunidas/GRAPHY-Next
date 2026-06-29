/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.PDVInputStream;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCStoreSCP;
import org.dcm4che3.net.service.DicomServiceException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * C-STORE 受信ハンドラ。受信ストリームを一時ファイルへ書き出し、
 * {@link DicomStorageService#ingest} に取り込みを委譲する。
 *
 * <p>取り込み（索引登録）に失敗した場合は一時ファイルを消し、SCU へ失敗ステータスを返す。
 */
public class DicomStoreScp extends BasicCStoreSCP {

    private final DicomStorageService storage;
    private final Path tempDir;

    public DicomStoreScp(DicomStorageService storage, Path tempDir) {
        super("*"); // 任意の Storage SOP Class を受け付ける
        this.storage = storage;
        this.tempDir = tempDir;
    }

    @Override
    protected void store(Association as, PresentationContext pc, Attributes rq, PDVInputStream data, Attributes rsp)
            throws IOException {
        String cuid = rq.getString(Tag.AffectedSOPClassUID);
        String iuid = rq.getString(Tag.AffectedSOPInstanceUID);
        String tsuid = pc.getTransferSyntax();

        Files.createDirectories(tempDir);
        Path temp = tempDir.resolve(iuid);

        Attributes fmi = as.createFileMetaInformation(iuid, cuid, tsuid);
        try (DicomOutputStream out = new DicomOutputStream(temp.toFile())) {
            out.writeFileMetaInformation(fmi);
            data.copyTo(out);
        }

        try {
            storage.ingest(temp);
        } catch (Exception e) {
            try {
                Files.deleteIfExists(temp);
            } catch (IOException ignore) {
                // ベストエフォート
            }
            throw new DicomServiceException(Status.ProcessingFailure, e);
        }
    }
}
