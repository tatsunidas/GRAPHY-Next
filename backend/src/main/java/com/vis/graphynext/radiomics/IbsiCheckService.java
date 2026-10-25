/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import io.github.tatsunidas.radiomics.main.Validation;
import io.github.tatsunidas.radiomics.main.ValidationReport;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.function.Supplier;

/**
 * RadiomicsJ の IBSI 1 照合（デジタルファントム）をこの PC の中で実行し、結果を返す。
 *
 * <p>照合の定義・判定の規則・参照値の表は RadiomicsJ のもの（{@link Validation#report}）。ここでは再計算も
 * 判定の書き換えもしない。RadiomicsJ の設定は static なので、{@link RadiomicsLock} の中で呼び、終わったら
 * 既定に戻す（続けて走る ROI 特徴量の計算が照合の設定を引き継がない）。
 *
 * <p>CT ファントム（構成 C・D）はこの PC では実行しない。画像は CC BY-NC で本体に同梱できないので、
 * RadiomicsJ のリリース時の記録（値だけ。{@code radiomics/ibsi-records/}）を読んで返す。
 */
@Service
public class IbsiCheckService {

    /** 結果。{@code report} は RadiomicsJ の {@code ValidationReport#toJson} そのまま、{@code csv} は {@code toCsv}。 */
    public record Result(String graphyVersion, String radiomicsjVersion, String ranAt, JsonNode report, String csv) {}

    private static final String RECORDS = "classpath:radiomics/ibsi-records/*.json";

    private final RadiomicsMode mode;
    private final ObjectMapper json;
    private final String graphyVersion;
    private final Supplier<ValidationReport> validation;
    private Result last;

    @Autowired
    public IbsiCheckService(RadiomicsMode mode, ObjectMapper json, @Value("${graphy.version:dev}") String graphyVersion) {
        this(mode, json, graphyVersion, () -> Validation.report(Validation.ValidationConfigType.P));
    }

    IbsiCheckService(RadiomicsMode mode, ObjectMapper json, String graphyVersion, Supplier<ValidationReport> validation) {
        this.mode = mode;
        this.json = json;
        this.graphyVersion = graphyVersion;
        this.validation = validation;
    }

    /**
     * 照合を実行する。同じ RadiomicsJ の版で実行済みなら、{@code refresh} でない限り覚えた結果を返す
     * （プロセスの中だけ。DB には書かない）。
     */
    public Result run(boolean refresh) {
        mode.require("IBSI 照合");
        return RadiomicsLock.get(() -> {
            if (!refresh && last != null && last.radiomicsjVersion().equals(RadiomicsJ.version)) {
                return last;
            }
            ValidationReport report;
            try {
                report = validation.get();
            } finally {
                RadiomicsJ.resetSettings();
            }
            try {
                last = new Result(graphyVersion, RadiomicsJ.version,
                        OffsetDateTime.now(ZoneId.systemDefault()).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                        json.readTree(report.toJson()), report.toCsv());
            } catch (IOException e) {
                throw new IllegalStateException("照合の結果を JSON として読めません: " + e.getMessage(), e);
            }
            return last;
        });
    }

    /** RadiomicsJ のリリース時の記録（CT ファントム 構成 C・D）。名前順。この PC では実行していない値。 */
    public List<JsonNode> records() {
        try {
            Resource[] found = new PathMatchingResourcePatternResolver().getResources(RECORDS);
            List<Resource> sorted = new ArrayList<>(Arrays.asList(found));
            sorted.sort(Comparator.comparing(r -> String.valueOf(r.getFilename())));
            List<JsonNode> out = new ArrayList<>();
            for (Resource r : sorted) {
                try (var in = r.getInputStream()) {
                    out.add(json.readTree(in));
                }
            }
            return out;
        } catch (IOException e) {
            throw new IllegalStateException("照合の記録を読めません: " + e.getMessage(), e);
        }
    }
}
