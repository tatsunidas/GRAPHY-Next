/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.anonymize.ReceiveAnonymizer;
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
    /** 受信時の匿名化。null なら何もしない（従来どおり）。 */
    private final ReceiveAnonymizer anonymizer;
    /** 受信時の可逆圧縮（匿名化の後）。null なら何もしない。 */
    private final ReceiveCompressor compressor;

    public DicomStoreScp(DicomStorageService storage, Path tempDir) {
        this(storage, tempDir, null, null);
    }

    public DicomStoreScp(DicomStorageService storage, Path tempDir, ReceiveAnonymizer anonymizer) {
        this(storage, tempDir, anonymizer, null);
    }

    public DicomStoreScp(DicomStorageService storage, Path tempDir, ReceiveAnonymizer anonymizer,
                         ReceiveCompressor compressor) {
        super("*"); // 任意の Storage SOP Class を受け付ける
        this.storage = storage;
        this.tempDir = tempDir;
        this.anonymizer = anonymizer;
        this.compressor = compressor;
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

        Path toIngest = temp;
        try {
            if (anonymizer != null) {
                // 原本は保管庫に入れない。匿名化できない・断るものは失敗を返す（一時ファイルは anonymizer が消す）。
                toIngest = anonymizer.process(temp, as.getCallingAET());
            }
            if (compressor != null) {
                toIngest = compressor.process(toIngest); // 失敗・対象外は元のまま（受信は失敗させない）
            }
            storage.ingest(toIngest);
        } catch (ReceiveAnonymizer.Rejected e) {
            deleteQuietly(temp);
            deleteQuietly(toIngest);
            throw new DicomServiceException(Status.ProcessingFailure, e.reason());
        } catch (Exception e) {
            deleteQuietly(temp);
            deleteQuietly(toIngest);
            throw new DicomServiceException(Status.ProcessingFailure, e);
        }
    }

    private static void deleteQuietly(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (IOException ignore) {
            // ベストエフォート
        }
    }
}
