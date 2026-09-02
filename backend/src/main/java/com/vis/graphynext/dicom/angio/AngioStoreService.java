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

    /**
     * 保管庫の GSPS を読んで表示状態にする（§14.1 の読み込み側）。
     *
     * <p>🚨 <b>読めなかったものは {@code warnings} に入って返る。</b> 他社の GSPS には
     * こちらが解釈しない項目が普通に入っており、黙って落とすと「適用したのに元と違う」に
     * なる（{@link XaPresentationStateReader} のクラスコメント）。
     *
     * @throws IllegalArgumentException 表示状態でない SOP Class だったとき
     * @throws IOException              インスタンスを読めなかったとき
     */
    public XaPresentationState readPresentationState(String sopUid) throws IOException {
        Attributes ds = readTemplate(sopUid);
        if (ds == null) {
            throw new IOException("インスタンスが見つかりません: " + sopUid);
        }
        return XaPresentationStateReader.read(ds);
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

    public Created createQlvSr(QlvSrRequest req) throws IOException {
        Attributes tmpl = readTemplate(req.sopInstanceUid());
        QlvSrWriter.Result r = QlvSrWriter.build(tmpl, req);
        store(r.dataset());
        log.info("QLV SR created: series={} sop={} (EF={})", r.seriesInstanceUid(), r.sopInstanceUid(),
                req.ejectionFraction());
        return new Created(r.seriesInstanceUid(), r.sopInstanceUid());
    }

    /**
     * 3D QCA（A6a）の結果を SR として保存する。
     *
     * <p>参照ヘッダは<b>方向 A の元インスタンス</b>から取る（患者・スタディは 2 方向で同じ）。
     * 2 方向の参照そのものは {@link Qca3dSrWriter} が両方書く。
     */
    public Created createQca3dSr(Qca3dSrRequest req) throws IOException {
        Attributes tmpl = readTemplate(req.viewASopInstanceUid());
        Qca3dSrWriter.Result r = Qca3dSrWriter.build(tmpl, req);
        store(r.dataset());
        log.info("QCA3D SR created: series={} sop={} (length={}mm, anchors={}, corrected={})",
                r.seriesInstanceUid(), r.sopInstanceUid(), req.lengthMm(), req.anchorCount(),
                req.angleCorrected());
        return new Created(r.seriesInstanceUid(), r.sopInstanceUid());
    }

    /**
     * プラグインが書くアンギオ解析 SR（H37 ／ G3）。中身と書き手は本体の経路と<b>同一</b>で、
     * 違うのは<b>出所を必ず刻む</b>ことだけ（{@link AngioSrProvenance}）。
     *
     * <p>🔴 <b>producer 無しは受け付けない。</b> 出所の無いプラグイン出力を作れてしまうと、
     * 保管庫の中で「本体が計算した値」と見分けが付かなくなる。
     *
     * @throws IllegalArgumentException kind が未知、対応する本体が空、producer が無いとき
     */
    public Created createPluginSr(AngioPluginSrRequest req) throws IOException {
        if (req == null || req.producer() == null || req.producer().id() == null
                || req.producer().id().isBlank()) {
            throw new IllegalArgumentException("producer は必須です");
        }
        String kind = req.kind() == null ? "" : req.kind().trim().toLowerCase();
        Attributes ds;
        String seriesUid;
        String sopUid;
        switch (kind) {
            case "qca" -> {
                require(req.qca() != null, "qca");
                QcaSrWriter.Result r = QcaSrWriter.build(readTemplate(req.qca().sopInstanceUid()), req.qca());
                ds = r.dataset();
                seriesUid = r.seriesInstanceUid();
                sopUid = r.sopInstanceUid();
            }
            case "qlv" -> {
                require(req.qlv() != null, "qlv");
                QlvSrWriter.Result r = QlvSrWriter.build(readTemplate(req.qlv().sopInstanceUid()), req.qlv());
                ds = r.dataset();
                seriesUid = r.seriesInstanceUid();
                sopUid = r.sopInstanceUid();
            }
            case "qca3d" -> {
                require(req.qca3d() != null, "qca3d");
                Qca3dSrWriter.Result r =
                        Qca3dSrWriter.build(readTemplate(req.qca3d().viewASopInstanceUid()), req.qca3d());
                ds = r.dataset();
                seriesUid = r.seriesInstanceUid();
                sopUid = r.sopInstanceUid();
            }
            // 🚨 知らない種別は**拒否する**（H9 と同じ）。黙って落とすと
            //    「入れたはずの計測が無いレポート」ができる。
            default -> throw new IllegalArgumentException("未知の解析種別です: " + req.kind());
        }
        AngioSrProvenance.stamp(ds, req.producer());
        store(ds);
        log.info("plugin angio SR created: kind={} plugin={} series={} sop={}",
                kind, req.producer().id(), seriesUid, sopUid);
        return new Created(seriesUid, sopUid);
    }

    /**
     * プラグインが書く XA GSPS（H38 ／ G4）。書き手は本体の経路と同じ
     * {@link XaPresentationStateWriter} で、違うのは<b>出所を必ず刻む</b>ことだけ。
     *
     * @throws IllegalArgumentException producer が無い／表示状態が空のとき
     */
    public Created createPluginPresentationState(AngioPluginPresentationRequest req) throws IOException {
        if (req == null || req.producer() == null || req.producer().id() == null
                || req.producer().id().isBlank()) {
            throw new IllegalArgumentException("producer は必須です");
        }
        AngioPresentationRequest ps = req.presentation();
        require(ps != null, "presentation");
        require(ps.sopInstanceUid() != null && !ps.sopInstanceUid().isBlank(), "sopInstanceUid");
        Attributes tmpl = readTemplate(ps.sopInstanceUid());
        int rows = tmpl == null ? 0 : tmpl.getInt(Tag.Rows, 0);
        int cols = tmpl == null ? 0 : tmpl.getInt(Tag.Columns, 0);
        XaPresentationStateWriter.Result r =
                XaPresentationStateWriter.build(tmpl == null ? new Attributes() : tmpl, ps, rows, cols);
        Attributes ds = r.dataset();
        AngioSrProvenance.stamp(ds, req.producer());
        store(ds);
        log.info("plugin XA GSPS created: plugin={} series={} sop={} (ref={})",
                req.producer().id(), r.seriesInstanceUid(), r.sopInstanceUid(), ps.sopInstanceUid());
        return new Created(r.seriesInstanceUid(), r.sopInstanceUid());
    }

    private static void require(boolean ok, String field) {
        if (!ok) {
            throw new IllegalArgumentException(field + " が空です");
        }
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
