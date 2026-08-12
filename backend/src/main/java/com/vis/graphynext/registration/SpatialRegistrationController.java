/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;

/**
 * DICOM SRO の REST（{@code /api/sro}）。
 *
 * <p>アプリ内保存（{@code /api/registrations/{patientKey}}）が「開き直せば同じ絵」を担うのに対し、
 * こちらは<b>患者記録として可搬な形で残す</b>ためのもの。
 *
 * <p>★ パスを {@code /api/registrations/sro} にしない。それだと
 * {@code /api/registrations/{patientKey}} と衝突し、<b>patientKey が "sro" の患者</b>を
 * 隠してしまう。実際、実装途中にこの URL を叩いたとき、SRO ではなく
 * 「patientKey=sro のアプリ内保存」が 200 を返し、動作確認が嘘になりかけた。
 */
@RestController
@RequestMapping("/api/sro")
public class SpatialRegistrationController {

    private final SpatialRegistrationService service;

    public SpatialRegistrationController(SpatialRegistrationService service) {
        this.service = service;
    }

    /**
     * SRO の生成要求。
     *
     * @param fixedToMoving GRAPHY 内部の向き（fixed world → moving world）の 4×4。
     *                      SRO へは逆行列で書かれる（{@link SpatialRegistrationCodec} の規約）。
     * @param dvf           非剛体のとき指定。null なら剛体 SRO。
     */
    public record CreateRequest(
            String studyInstanceUid,
            String fixedSeriesInstanceUid,
            String fixedFrameOfReferenceUid,
            String movingFrameOfReferenceUid,
            double[] fixedToMoving,
            DvfDto dvf,
            String contentLabel,
            String contentDescription) {
    }

    public record DvfDto(int[] dims, double[] originMm, double[] spacingMm, float[] displacementsMm) {
    }

    @PostMapping
    public SpatialRegistrationService.CreateResult create(@RequestBody CreateRequest req) throws IOException {
        SpatialRegistrationCodec.Dvf dvf = req.dvf() == null ? null
                : new SpatialRegistrationCodec.Dvf(req.dvf().dims(), req.dvf().originMm(),
                        req.dvf().spacingMm(), req.dvf().displacementsMm());
        return service.create(
                req.studyInstanceUid(),
                req.fixedSeriesInstanceUid(),
                new SpatialRegistrationCodec.Input(null,
                        req.fixedFrameOfReferenceUid(), req.movingFrameOfReferenceUid(),
                        req.fixedToMoving(), dvf, req.contentLabel(), req.contentDescription()));
    }

    /** 検査の中の SRO を列挙する。 */
    @GetMapping
    public List<SpatialRegistrationCodec.Parsed> list(@RequestParam String studyInstanceUid) throws IOException {
        return service.list(studyInstanceUid);
    }
}
