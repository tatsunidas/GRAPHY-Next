/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.web;

import com.vis.graphynext.dicom.DicomProperties;
import jakarta.json.Json;
import jakarta.json.stream.JsonParser;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.json.JSONReader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
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
