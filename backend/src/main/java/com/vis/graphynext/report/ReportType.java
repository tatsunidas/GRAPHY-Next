/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import java.util.Set;

/**
 * レポート種別。確定（SR 化、フェーズ2）時に必要な検証者ロールを規定する
 * （空集合=制限なし。{@link StaffRole#PHYSICIAN} は常に検証可＝上位ロール扱い、旧実装を踏襲）。
 */
public enum ReportType {
    GENERAL(Set.of()),
    IMAGING_DIAGNOSTIC(Set.of(StaffRole.PHYSICIAN)),
    TECHNOLOGIST(Set.of(StaffRole.RADIOLOGIC_TECHNOLOGIST)),
    MEASUREMENT(Set.of());

    private final Set<StaffRole> allowedVerifierRoles;

    ReportType(Set<StaffRole> allowedVerifierRoles) {
        this.allowedVerifierRoles = allowedVerifierRoles;
    }

    public Set<StaffRole> allowedVerifierRoles() {
        return allowedVerifierRoles;
    }

    public boolean canVerify(StaffRole role) {
        return allowedVerifierRoles.isEmpty() || allowedVerifierRoles.contains(role) || role == StaffRole.PHYSICIAN;
    }
}
