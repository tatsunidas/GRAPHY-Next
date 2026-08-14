/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * アンギオの派生オブジェクト（GSPS / QCA SR）を作って保管する（{@code fw/angio-design.md} §14 / A10）。
 *
 * <p>🚨 <b>web モードでは {@code storage.ingest()} ではなく STOW-RS で PACS へ書き戻す。</b>
 * ingest 固定だと生成物がローカル H2 にしか無く、web の検査一覧（QIDO）に現れない
 * 「見えない SR」になる（レポート機能で実際に踏んだ穴。{@code report/ReportService} と同型）。
 */
@Service
public class AngioStoreService {

    private static final Logger log = LoggerFactory.getLogger(AngioStoreService.class);

    private final DicomStorageService storage;
    private final ObjectProvider<WebDicomDataService> webProvider;

    public AngioStoreService(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider) {
        this.storage = storage;
        this.webProvider = webProvider;
    }

    /** 作成結果。 */
    public record Created(String seriesInstanceUid, String sopInstanceUid) {
    }

    /** XA/XRF GSPS を作って保存する。 */
    public Created createPresentationState(AngioPresentationRequest req) throws IOException {
        Attributes tmpl = readTemplate(req.sopInstanceUid());
        int rows = tmpl == null ? 0 : tmpl.getInt(Tag.Rows, 0);
        int cols = tmpl == null ? 0 : tmpl.getInt(Tag.Columns, 0);
        XaPresentationStateWriter.Result r =
                XaPresentationStateWriter.build(tmpl == null ? new Attributes() : tmpl, req, rows, cols);
        store(r.dataset());
        log.info("XA GSPS created: series={} sop={} (ref={})", r.seriesInstanceUid(), r.sopInstanceUid(),
                req.sopInstanceUid());
        return new Created(r.seriesInstanceUid(), r.sopInstanceUid());
    }

    /** QCA 結果の SR を作って保存する。 */
    public Created createQcaSr(QcaSrRequest req) throws IOException {
        Attributes tmpl = readTemplate(req.sopInstanceUid());
        QcaSrWriter.Result r = QcaSrWriter.build(tmpl, req);
        store(r.dataset());
        log.info("QCA SR created: series={} sop={} (%DS={})", r.seriesInstanceUid(), r.sopInstanceUid(),
                req.percentDiameterStenosis());
        return new Created(r.seriesInstanceUid(), r.sopInstanceUid());
    }

    /** 参照インスタンスのヘッダ（患者・スタディ識別情報の継承元）。取れなければ null。 */
    private Attributes readTemplate(String sopUid) {
        Path p = storage.resolveInstanceFile(sopUid);
        if (p == null) {
            return null;
        }
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        } catch (IOException e) {
            log.warn("angio: 参照インスタンスのヘッダを読めませんでした {}", sopUid, e);
            return null;
        }
    }

    private void store(Attributes ds) throws IOException {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            web.storeDatasets(List.of(ds));
            return;
        }
        Path tmp = Files.createTempFile("angio-", ".dcm");
        boolean consumed = false;
        try {
            Attributes fmi = ds.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, ds);
            }
            storage.ingest(tmp); // 成功時 tmp は正規パスへ移動
            consumed = true;
        } finally {
            if (!consumed) {
                Files.deleteIfExists(tmp);
            }
        }
    }
}
