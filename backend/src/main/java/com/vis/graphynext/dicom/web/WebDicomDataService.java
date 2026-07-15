/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.web;

import com.vis.graphynext.dicom.DicomProperties;
import jakarta.json.Json;
import jakarta.json.stream.JsonParser;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.json.JSONReader;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * web モードの BFF。フロントエンドからの要求を外部 PACS の DICOMweb（QIDO-RS）へ中継する。
 *
 * <p>接続先・認証は {@code graphy.dicom.dicomweb.*}。dcm4chee / Orthanc 等、DICOMweb を話す
 * サーバなら接続設定の違いだけで共通に使える。当面は検索（QIDO-RS）を実装。
 */
@Service
@Profile("web")
public class WebDicomDataService {

    private static final Logger log = LoggerFactory.getLogger(WebDicomDataService.class);
    private static final MediaType DICOM_JSON = MediaType.valueOf("application/dicom+json");

    private final RestClient client;
    private final String baseUrl;

    /**
     * シリーズ一括取得（prefetch）で取り込んだインスタンス本体の簡易キャッシュ（sopUID→Part-10 バイト）。
     * MPR/3D/Slicer 等が全スライスを個別に WADO-RS 取得すると遅いため、prefetch で 1 リクエストにまとめ、
     * 以降の {@code /instances/{sop}/file} をここから即返す。合計バイト上限つき LRU（超過は古い順に破棄）。
     * 単一利用者の BFF 前提の素朴な実装（マルチテナントでの共有は将来課題）。
     */
    private static final long CACHE_MAX_BYTES = 512L * 1024 * 1024; // 512MB
    private final LinkedHashMap<String, byte[]> instanceCache = new LinkedHashMap<>(64, 0.75f, true);
    private long cacheBytes = 0;

    /** キャッシュ取得（アクセス順更新）。無ければ null。 */
    private synchronized byte[] cacheGet(String sopUid) {
        return instanceCache.get(sopUid);
    }

    /** キャッシュ投入。合計バイトが上限を超えたら古い順（LRU）に破棄する。 */
    private synchronized void cachePut(String sopUid, byte[] dicom) {
        if (sopUid == null || dicom == null) {
            return;
        }
        byte[] prev = instanceCache.put(sopUid, dicom);
        if (prev != null) {
            cacheBytes -= prev.length;
        }
        cacheBytes += dicom.length;
        var it = instanceCache.entrySet().iterator();
        while (cacheBytes > CACHE_MAX_BYTES && it.hasNext()) {
            Map.Entry<String, byte[]> eldest = it.next();
            cacheBytes -= eldest.getValue().length;
            it.remove();
        }
    }

    /**
     * ブランク生成用テンプレート（シリーズ代表インスタンスの属性）の簡易キャッシュ（seriesUID→Attributes）。
     * シリーズ全体の {@link #seriesMetadata} は重いため、gap 埋めのたびに叩き直さないよう件数上限つき LRU で保持する。
     */
    private static final int BLANK_TEMPLATE_CACHE_MAX = 64;
    private final LinkedHashMap<String, Attributes> blankTemplateCache = new LinkedHashMap<>(16, 0.75f, true);

    private synchronized Attributes blankTemplateGet(String seriesUid) {
        return blankTemplateCache.get(seriesUid);
    }

    private synchronized void blankTemplatePut(String seriesUid, Attributes tmpl) {
        blankTemplateCache.put(seriesUid, tmpl);
        var it = blankTemplateCache.entrySet().iterator();
        while (blankTemplateCache.size() > BLANK_TEMPLATE_CACHE_MAX && it.hasNext()) {
            it.next();
            it.remove();
        }
    }

    public WebDicomDataService(DicomProperties props) {
        DicomProperties.Dicomweb cfg = props.getDicomweb();
        this.baseUrl = cfg.getBaseUrl() == null ? "" : cfg.getBaseUrl().trim();
        RestClient.Builder b = RestClient.builder().baseUrl(baseUrl);
        if (cfg.getBearerToken() != null && !cfg.getBearerToken().isBlank()) {
            b.defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + cfg.getBearerToken());
        }
        this.client = b.build();
        log.debug("WebDicomDataService initialized: baseUrl={}", baseUrl); // 毎構築で出るため DEBUG
    }

    /** QIDO-RS: Study 検索。 */
    public List<Attributes> searchStudies(Map<String, String> query) {
        return qido("/studies", query);
    }

    /** QIDO-RS: Series 検索。 */
    public List<Attributes> searchSeries(String studyUid, Map<String, String> query) {
        return qido("/studies/" + studyUid + "/series", query);
    }

    /** QIDO-RS: Instance 検索。 */
    public List<Attributes> searchInstances(String studyUid, String seriesUid, Map<String, String> query) {
        return qido("/studies/" + studyUid + "/series/" + seriesUid + "/instances", query);
    }

    /**
     * dcm4chee 等にそのスタディ（seriesUid != null ならそのシリーズ）が何インスタンス保存済みかを QIDO で数える
     * （QR の保存済み判定）。インスタンス QIDO の件数を返す。未保存/未到達は 0。
     */
    public long storedCount(String studyUid, String seriesUid) {
        try {
            if (seriesUid != null && !seriesUid.isBlank()) {
                return searchInstances(studyUid, seriesUid, Map.of()).size();
            }
            // スタディ全体は series ごとの NumberOfSeriesRelatedInstances を合算（インスタンス QIDO の全列挙を避ける）。
            long sum = 0;
            for (Attributes se : searchSeries(studyUid, Map.of())) {
                sum += se.getInt(org.dcm4che3.data.Tag.NumberOfSeriesRelatedInstances, 0);
            }
            return sum;
        } catch (Exception e) {
            log.warn("QIDO 保存済み件数取得に失敗 study={} series={}: {}", studyUid, seriesUid, e.toString());
            return 0;
        }
    }

    /**
     * WADO-RS: 指定シリーズの全インスタンスのメタデータ（全属性）を取得する（TagExtractor の web 取得元）。
     * {@code GET {base}/studies/{study}/series/{series}/metadata}（application/dicom+json）。
     * QIDO は要約属性しか返さないため、シーケンス/Private を含む全タグ抽出にはこちらを使う。
     */
    public List<Attributes> seriesMetadata(String studyUid, String seriesUid) {
        if (baseUrl.isEmpty()) {
            throw new IllegalStateException(
                    "DICOMweb 接続先が未設定です（graphy.dicom.dicomweb.base-url）。");
        }
        String path = "/studies/" + studyUid + "/series/" + seriesUid + "/metadata";
        log.debug("WADO-RS metadata request: {}", path);
        byte[] body = client.get()
                .uri(ub -> ub.path(path).build())
                .accept(DICOM_JSON)
                .retrieve()
                .body(byte[].class);
        List<Attributes> result = parseDatasets(body);
        log.debug("WADO-RS metadata: {} -> {} instances", path, result.size());
        return result;
    }

    /** ブランク画像へ引き継ぐ「患者関係」タグ。 */
    private static final int[] BLANK_PATIENT_TAGS = {
            Tag.SpecificCharacterSet,
            Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex, Tag.PatientAge,
    };

    /** ブランク画像へ引き継ぐ「Image 属性」タグ（幾何・画素形式・表示パラメータ）。 */
    private static final int[] BLANK_IMAGE_TAGS = {
            Tag.Modality, Tag.Rows, Tag.Columns, Tag.SamplesPerPixel, Tag.PhotometricInterpretation,
            Tag.BitsAllocated, Tag.BitsStored, Tag.HighBit, Tag.PixelRepresentation,
            Tag.PixelSpacing, Tag.SliceThickness, Tag.SpacingBetweenSlices,
            Tag.ImageOrientationPatient, Tag.FrameOfReferenceUID, Tag.PositionReferenceIndicator,
            Tag.RescaleSlope, Tag.RescaleIntercept, Tag.RescaleType,
            Tag.WindowCenter, Tag.WindowWidth,
    };

    /**
     * web: 範囲外パディング用ブランク DICOM を生成する（standalone の
     * {@link com.vis.graphynext.dicom.store.DicomStorageService#blankDicom} と同じ用途）。ある C/T が
     * 覆わない Z 位置を、近傍スライスの代用ではなく物理座標に揃えたブランクで埋めるために frontend が
     * wadouri で読む。
     *
     * <p>ローカル索引を持たないため、シリーズ代表インスタンス（WADO-RS {@code /metadata} の先頭）を
     * テンプレートにするが、全属性を複製する standalone とは異なり、必須タグ（患者関係・UID・Image 属性）
     * のみを引き継いだ最小構成で組み立てる。画素はシリーズ最小値（推定不能なら 0）で埋める。
     *
     * @return Part-10 DICOM バイト列。テンプレートが取得できない／幾何が不正なら {@code null}。
     */
    public byte[] blankDicom(String studyUid, String seriesUid, double[] ipp) {
        Attributes src = blankTemplateGet(seriesUid);
        if (src == null) {
            List<Attributes> meta;
            try {
                meta = seriesMetadata(studyUid, seriesUid);
            } catch (Exception e) {
                log.warn("web blank: metadata取得失敗 series={}: {}", seriesUid, e.toString());
                return null;
            }
            if (meta.isEmpty()) {
                return null;
            }
            src = meta.get(0);
            blankTemplatePut(seriesUid, src);
        }
        int rows = src.getInt(Tag.Rows, 0);
        int cols = src.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) {
            return null;
        }
        try {
            Attributes a = new Attributes();
            for (int tag : BLANK_PATIENT_TAGS) {
                copyTag(src, a, tag);
            }
            a.setString(Tag.StudyInstanceUID, VR.UI, studyUid);
            a.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
            a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
            a.setInt(Tag.InstanceNumber, VR.IS, 0);
            a.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY", "BLANK");
            if (ipp != null && ipp.length == 3) {
                a.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
            }
            boolean seg = UID.SegmentationStorage.equals(src.getString(Tag.SOPClassUID));
            byte[] px;
            if (seg) {
                // SEG は表示時 8bit MONOCHROME2(0/255) に展開されるため、gap ブランクも同形式（全0）で返す。
                a.setString(Tag.SOPClassUID, VR.UI, UID.SegmentationStorage);
                a.setInt(Tag.Rows, VR.US, rows);
                a.setInt(Tag.Columns, VR.US, cols);
                a.setInt(Tag.SamplesPerPixel, VR.US, 1);
                a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
                a.setInt(Tag.BitsAllocated, VR.US, 8);
                a.setInt(Tag.BitsStored, VR.US, 8);
                a.setInt(Tag.HighBit, VR.US, 7);
                a.setInt(Tag.PixelRepresentation, VR.US, 0);
                copyTag(src, a, Tag.ImageOrientationPatient);
                copyTag(src, a, Tag.PixelSpacing);
                a.setDouble(Tag.WindowCenter, VR.DS, 127.0);
                a.setDouble(Tag.WindowWidth, VR.DS, 255.0);
                px = new byte[rows * cols];
                a.setBytes(Tag.PixelData, VR.OB, px);
            } else {
                for (int tag : BLANK_IMAGE_TAGS) {
                    copyTag(src, a, tag);
                }
                String sopClass = src.getString(Tag.SOPClassUID);
                a.setString(Tag.SOPClassUID, VR.UI, sopClass != null ? sopClass : UID.SecondaryCaptureImageStorage);
                int bits = src.getInt(Tag.BitsAllocated, 16);
                int samples = src.getInt(Tag.SamplesPerPixel, 1);
                int pad = paddingValue(src);
                int nSamples = rows * cols * samples;
                int bytesPerSample = Math.max(1, bits / 8);
                px = new byte[nSamples * bytesPerSample];
                if (bytesPerSample >= 2) {
                    short v = (short) pad;
                    for (int i = 0; i < nSamples; i++) {
                        px[i * 2] = (byte) (v & 0xff);
                        px[i * 2 + 1] = (byte) ((v >> 8) & 0xff);
                    }
                } else if (pad != 0) {
                    Arrays.fill(px, (byte) pad);
                }
                a.setBytes(Tag.PixelData, bits > 8 ? VR.OW : VR.OB, px);
            }
            if (a.getString(Tag.SpecificCharacterSet) == null) {
                a.setSpecificCharacterSet("ISO_IR 192");
            }

            ByteArrayOutputStream bos = new ByteArrayOutputStream(px.length + 8192);
            Attributes fmi = a.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(bos, UID.ExplicitVRLittleEndian)) {
                dos.writeDataset(fmi, a);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            log.warn("web blank 生成失敗 series={}: {}", seriesUid, e.toString());
            return null;
        }
    }

    /** タグ 1 個を VR・多値を保ってコピーする（存在時のみ）。 */
    private static void copyTag(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) {
            return;
        }
        VR vr = from.getVR(tag);
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) {
            to.setString(tag, vr, v);
        }
    }

    /**
     * ブランク画素の埋め値（stored 値）。SmallestImagePixelValue → PixelPaddingValue →
     * (WindowCenter-WindowWidth/2 を stored 換算) → 0 の順にフォールバック
     * （{@link com.vis.graphynext.dicom.store.DicomStorageService#blankDicom} と同じ規則）。
     */
    private static int paddingValue(Attributes ds) {
        if (ds.contains(Tag.SmallestImagePixelValue)) {
            return ds.getInt(Tag.SmallestImagePixelValue, 0);
        }
        if (ds.contains(Tag.PixelPaddingValue)) {
            return ds.getInt(Tag.PixelPaddingValue, 0);
        }
        Double wc = readNumeric(ds, Tag.WindowCenter);
        Double ww = readNumeric(ds, Tag.WindowWidth);
        if (wc == null || ww == null) {
            return 0;
        }
        double slope = readNumeric(ds, Tag.RescaleSlope) != null ? readNumeric(ds, Tag.RescaleSlope) : 1.0;
        double intercept = readNumeric(ds, Tag.RescaleIntercept) != null ? readNumeric(ds, Tag.RescaleIntercept) : 0.0;
        double floorOut = wc - ww / 2.0;
        return (int) Math.round((floorOut - intercept) / (slope == 0 ? 1 : slope));
    }

    /** 数値タグを VR 非依存で読む（IS/DS いずれも文字列表現から）。読めなければ null。 */
    private static Double readNumeric(Attributes ds, int tag) {
        if (!ds.contains(tag)) {
            return null;
        }
        String s = ds.getString(tag);
        if (s == null || s.trim().isEmpty()) {
            return null;
        }
        try {
            return Double.parseDouble(s.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * WADO-RS: 1 インスタンスの本体（Part-10 DICOM）を取得する。
     * {@code GET {base}/studies/{study}/series/{series}/instances/{sop}}
     * （{@code Accept: multipart/related; type="application/dicom"}）。
     *
     * <p>ピクセル経路も BFF 一本に統一する方針（fw/dicom-data-layer.md §5）。フロントは
     * {@code wadouri:.../instances/{sop}/file} として Cornerstone3D に読ませる。応答は multipart/related
     * のため、単一パート（＝DICOM 本体）を抜き出して返す。標準圧縮 TS はブラウザ(WASM)側で復号する。
     *
     * @return Part-10 DICOM バイト列。取得不能なら {@code null}。
     */
    public byte[] retrieveInstance(String studyUid, String seriesUid, String sopUid) {
        // prefetch 済みならキャッシュから即返す（個別 WADO-RS 往復を省く）。
        byte[] cached = cacheGet(sopUid);
        if (cached != null) {
            return cached;
        }
        if (baseUrl.isEmpty()) {
            throw new IllegalStateException(
                    "DICOMweb 接続先が未設定です（graphy.dicom.dicomweb.base-url）。");
        }
        String path = "/studies/" + studyUid + "/series/" + seriesUid + "/instances/" + sopUid;
        log.debug("WADO-RS instance request: {}", path);
        ResponseEntity<byte[]> resp = client.get()
                .uri(ub -> ub.path(path).build())
                .accept(MediaType.parseMediaType("multipart/related;type=\"application/dicom\""))
                .retrieve()
                .toEntity(byte[].class);
        byte[] body = resp.getBody();
        if (body == null || body.length == 0) {
            return null;
        }
        MediaType ct = resp.getHeaders().getContentType();
        String boundary = ct == null ? null : ct.getParameter("boundary");
        byte[] dicom = firstMultipartPart(body, boundary);
        log.debug("WADO-RS instance: {} -> {} bytes (part {} bytes)", path, body.length,
                dicom == null ? 0 : dicom.length);
        if (dicom != null) {
            cachePut(sopUid, dicom);
        }
        return dicom;
    }

    /**
     * WADO-RS: シリーズ全インスタンスを 1 リクエストで一括取得し、キャッシュに投入する（prefetch）。
     * {@code GET {base}/studies/{study}/series/{series}}（multipart/related; type="application/dicom"）。
     * 以降の {@link #retrieveInstance} はキャッシュから即返る（MPR/3D/Slicer の高速化）。
     *
     * @return 取り込んだインスタンス数。
     */
    public int prefetchSeries(String studyUid, String seriesUid) {
        if (baseUrl.isEmpty()) {
            throw new IllegalStateException(
                    "DICOMweb 接続先が未設定です（graphy.dicom.dicomweb.base-url）。");
        }
        String path = "/studies/" + studyUid + "/series/" + seriesUid;
        log.debug("WADO-RS series request (prefetch): {}", path);
        ResponseEntity<byte[]> resp = client.get()
                .uri(ub -> ub.path(path).build())
                .accept(MediaType.parseMediaType("multipart/related;type=\"application/dicom\""))
                .retrieve()
                .toEntity(byte[].class);
        byte[] body = resp.getBody();
        if (body == null || body.length == 0) {
            return 0;
        }
        MediaType ct = resp.getHeaders().getContentType();
        String boundary = ct == null ? null : ct.getParameter("boundary");
        List<byte[]> parts = allMultipartParts(body, boundary);
        int n = 0;
        for (byte[] dicom : parts) {
            String sop = sopInstanceUidOf(dicom);
            if (sop != null) {
                cachePut(sop, dicom);
                n++;
            }
        }
        log.info("WADO-RS series prefetch: {} -> {} instances cached (bulk retrieve)", path, n);
        return n;
    }

    /** Part-10 バイト列から SOPInstanceUID を読む。読めなければ null。 */
    private static String sopInstanceUidOf(byte[] dicom) {
        try (DicomInputStream dis = new DicomInputStream(new ByteArrayInputStream(dicom))) {
            Attributes fmi = dis.readFileMetaInformation();
            String sop = fmi != null ? fmi.getString(Tag.MediaStorageSOPInstanceUID) : null;
            if (sop != null && !sop.isBlank()) {
                return sop;
            }
            Attributes ds = dis.readDataset();
            return ds.getString(Tag.SOPInstanceUID);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * STOW-RS: Part-10 DICOM 群を PACS へ保存する（派生シリーズ・ROI の書き戻し）。
     * {@code POST {base}/studies}（Content-Type: multipart/related; type="application/dicom"）。
     *
     * @throws IllegalStateException 接続先未設定
     */
    /**
     * STOW-RS: dcm4che の {@link Attributes} 群を Part-10（Explicit VR LE）へ直列化して PACS へ保存する。
     * 派生シリーズ・SEG・RTSTRUCT の書き戻し共通入口。
     */
    public void storeDatasets(List<Attributes> datasets) {
        if (datasets == null || datasets.isEmpty()) {
            return;
        }
        List<byte[]> parts = new ArrayList<>(datasets.size());
        for (Attributes a : datasets) {
            Attributes fmi = a.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            try (DicomOutputStream dos = new DicomOutputStream(bos, UID.ExplicitVRLittleEndian)) {
                dos.writeDataset(fmi, a);
            } catch (java.io.IOException e) {
                throw new IllegalStateException("STOW 用の DICOM 直列化に失敗しました: " + e.getMessage(), e);
            }
            parts.add(bos.toByteArray());
        }
        storeInstances(parts);
    }

    public void storeInstances(List<byte[]> dicoms) {
        if (baseUrl.isEmpty()) {
            throw new IllegalStateException(
                    "DICOMweb 接続先が未設定です（graphy.dicom.dicomweb.base-url）。");
        }
        if (dicoms == null || dicoms.isEmpty()) {
            return;
        }
        String boundary = "graphyStow" + Integer.toHexString(System.identityHashCode(dicoms));
        byte[] payload = buildMultipartRelated(dicoms, boundary, "application/dicom");
        MediaType contentType = MediaType.parseMediaType(
                "multipart/related; type=\"application/dicom\"; boundary=" + boundary);
        log.debug("STOW-RS store: {} instances ({} bytes)", dicoms.size(), payload.length);
        client.post()
                .uri("/studies")
                .contentType(contentType)
                .accept(DICOM_JSON)
                .body(payload)
                .retrieve()
                .toBodilessEntity();
    }

    /**
     * multipart/related 応答から最初のパートの本体バイト列を抜き出す。単一インスタンス取得は
     * パートが 1 つのため、これで DICOM 本体が得られる。boundary が無ければ本体をそのまま返す
     * （サーバが単一パートを直接返した場合の保険）。
     */
    static byte[] firstMultipartPart(byte[] body, String boundary) {
        if (body == null) {
            return null;
        }
        if (boundary == null || boundary.isBlank()) {
            return body; // multipart でない（単一 DICOM 直返し）とみなす
        }
        // boundary はダブルクオートで囲まれることがある。
        String b = boundary.trim();
        if (b.length() >= 2 && b.startsWith("\"") && b.endsWith("\"")) {
            b = b.substring(1, b.length() - 1);
        }
        byte[] delim = ("--" + b).getBytes(StandardCharsets.US_ASCII);
        int p = indexOf(body, delim, 0);
        if (p < 0) {
            return body;
        }
        // パートヘッダ終端（CRLF CRLF）の後ろが本体の先頭。
        byte[] headerEnd = { 13, 10, 13, 10 };
        int hs = indexOf(body, headerEnd, p);
        if (hs < 0) {
            return null;
        }
        int start = hs + headerEnd.length;
        // 次の "CRLF --boundary" が本体の終端。無ければ末尾まで。
        byte[] endDelim = ("\r\n--" + b).getBytes(StandardCharsets.US_ASCII);
        int end = indexOf(body, endDelim, start);
        if (end < 0) {
            end = body.length;
        }
        return Arrays.copyOfRange(body, start, end);
    }

    /** multipart/related 応答の全パート本体を順に抜き出す（シリーズ一括取得用）。boundary 無しは body 1 個。 */
    static List<byte[]> allMultipartParts(byte[] body, String boundary) {
        List<byte[]> parts = new ArrayList<>();
        if (body == null) {
            return parts;
        }
        if (boundary == null || boundary.isBlank()) {
            parts.add(body);
            return parts;
        }
        String b = boundary.trim();
        if (b.length() >= 2 && b.startsWith("\"") && b.endsWith("\"")) {
            b = b.substring(1, b.length() - 1);
        }
        byte[] delim = ("--" + b).getBytes(StandardCharsets.US_ASCII);
        byte[] headerEnd = { 13, 10, 13, 10 };
        byte[] crlfDelim = ("\r\n--" + b).getBytes(StandardCharsets.US_ASCII);
        int pos = indexOf(body, delim, 0);
        while (pos >= 0) {
            int afterDelim = pos + delim.length;
            // 終端境界 "--boundary--" なら終了。
            if (afterDelim + 1 < body.length && body[afterDelim] == '-' && body[afterDelim + 1] == '-') {
                break;
            }
            int hs = indexOf(body, headerEnd, pos);
            if (hs < 0) {
                break;
            }
            int start = hs + headerEnd.length;
            int end = indexOf(body, crlfDelim, start);
            if (end < 0) {
                end = body.length;
            }
            parts.add(Arrays.copyOfRange(body, start, end));
            pos = indexOf(body, delim, end);
        }
        return parts;
    }

    /** Part-10 群を multipart/related バイト列に組み立てる（STOW-RS 送信ボディ）。 */
    static byte[] buildMultipartRelated(List<byte[]> parts, String boundary, String partContentType) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(("--" + boundary + "\r\n").getBytes(StandardCharsets.US_ASCII));
            out.writeBytes(("Content-Type: " + partContentType + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.writeBytes(part);
            out.writeBytes("\r\n".getBytes(StandardCharsets.US_ASCII));
        }
        out.writeBytes(("--" + boundary + "--").getBytes(StandardCharsets.US_ASCII));
        return out.toByteArray();
    }

    /** バイト列 {@code a} 中で {@code from} 以降に現れる部分列 {@code b} の先頭位置。無ければ -1。 */
    private static int indexOf(byte[] a, byte[] b, int from) {
        if (b.length == 0 || a.length - b.length < 0) {
            return -1;
        }
        outer:
        for (int i = Math.max(0, from); i <= a.length - b.length; i++) {
            for (int j = 0; j < b.length; j++) {
                if (a[i + j] != b[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    private List<Attributes> qido(String path, Map<String, String> query) {
        if (baseUrl.isEmpty()) {
            throw new IllegalStateException(
                    "DICOMweb 接続先が未設定です。環境設定の DICOM通信 で PACS の RS ベース URL"
                    + "（graphy.dicom.dicomweb.base-url）を設定してください。");
        }
        // 実 PACS 相手は未検証のため、リクエストと件数を DEBUG で残す（トラブル追跡用）。
        log.debug("QIDO request: {} query={}", path, query);
        byte[] body = client.get()
                .uri(ub -> {
                    ub.path(path);
                    if (query != null) {
                        query.forEach(ub::queryParam);
                    }
                    return ub.build();
                })
                .accept(DICOM_JSON)
                .retrieve()
                .body(byte[].class);
        List<Attributes> result = parseDatasets(body);
        log.debug("QIDO response: {} -> {} datasets ({} bytes)", path, result.size(), body == null ? 0 : body.length);
        return result;
    }

    /** DICOM JSON 配列（QIDO 応答）を Attributes のリストへ。204/空は空リスト。 */
    static List<Attributes> parseDatasets(byte[] json) {
        List<Attributes> out = new ArrayList<>();
        if (json == null || json.length == 0) {
            return out;
        }
        try (JsonParser parser = Json.createParser(new ByteArrayInputStream(json))) {
            new JSONReader(parser).readDatasets((fmi, dataset) -> out.add(dataset));
        }
        return out;
    }
}
