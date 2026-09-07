/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.anonymize.AnonymizeController.AnonRequest;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 匿名化リクエストの検査（Spring 起動も Mockito も不要な純粋テスト）。
 *
 * <p>🔴 <b>なぜここまで下げたか</b>: この JDK では Mockito が {@code ObjectProvider} をモックできず、
 * {@code AnonymizePreflightTest} など既存の Spring 系テストが軒並みエラーになる。検査ロジックは
 * コントローラの入口にあるので、そこだけ package-private にして直接呼ぶ。
 */
class AnonymizeRequestValidationTest {

    private static final String FULL = "RetainLongitudinalTemporalInformationFullDates";
    private static final String MOD = "RetainLongitudinalTemporalInformationModifiedDates";

    private static AnonRequest req(List<String> options) {
        return new AnonRequest(List.of("1.2.3"), options, "de-identified", "de-identified",
                null, null, null, false, null);
    }

    // ------------------------------------------------------------------------
    // 日付オプションの排他
    //
    // PS3.15 では Full Dates と Modified Dates は排他だが UI は両方 ON にでき、
    // AnonymizeConfig.getActionByOptionsAndDefault() の「加工(C,X)は保持(K)より優先」で
    // Full Dates が負けて日付が潰れていた（2026-08-20 実測: 20260101 → 20000101）。
    // ------------------------------------------------------------------------

    @Test
    void validate_bothDateOptions_isRejected() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> AnonymizeController.validate(req(List.of(FULL, MOD))));
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatusCode(), "両方 ON は受け付けない");
        assertTrue(e.getReason() != null && e.getReason().contains("排他"), "理由を伝える: " + e.getReason());
    }

    @Test
    void validate_eitherDateOptionAlone_isAccepted() {
        assertDoesNotThrow(() -> AnonymizeController.validate(req(List.of(FULL))));
        assertDoesNotThrow(() -> AnonymizeController.validate(req(List.of(MOD))));
    }

    @Test
    void validate_neitherDateOption_isAccepted() {
        // 両方 OFF は有効な選択（＝Basic Profile の日付削除）。
        assertDoesNotThrow(() -> AnonymizeController.validate(req(List.of("RetainUIDs"))));
        assertDoesNotThrow(() -> AnonymizeController.validate(req(null)));
    }

    @Test
    void validate_emptyStudyUids_isRejected() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> AnonymizeController.validate(new AnonRequest(List.of(), null, null, null,
                        null, null, null, false, null)));
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatusCode());
    }

    // ------------------------------------------------------------------------
    // 未知オプション
    // ------------------------------------------------------------------------

    @Test
    void toConfig_unknownOption_isRejected_insteadOfSilentlyIgnored() {
        // 🔴 脱識別で「読めなかった設定を黙って無視」は、利用者が指定したつもりの保護が
        // そのまま消えることを意味する。綴り違い 1 つで保護が外れた出力が出るくらいなら止める。
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> AnonymizeController.toConfig(req(List.of("RetainUID"))));
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatusCode());
        assertTrue(e.getReason() != null && e.getReason().contains("RetainUID"),
                "どのオプションが読めなかったかを伝える: " + e.getReason());
    }

    @Test
    void toConfig_knownOptions_areApplied() {
        AnonymizeConfig cfg = AnonymizeController.toConfig(req(List.of("RetainUIDs", MOD)));
        assertTrue(cfg.hasOption(AnonymizeConfig.Option.RetainUIDs));
        assertTrue(cfg.hasOption(AnonymizeConfig.Option.RetainLongitudinalTemporalInformationModifiedDates));
    }

    // ------------------------------------------------------------------------
    // 焼き込みが実行できないなら書き出す前に止める
    //
    // 「一部だけ塗れた ZIP」を黙って渡すのが最も危険 —— 受け取り側は ZIP 全体が clean だと
    // 解釈する。ZIP はストリーミングなので 1 バイト流したらステータスを変えられない。
    // ------------------------------------------------------------------------

    private static AnonymizeController controllerWithMasks(int maskCount) {
        AnonymizeMaskStore store = new AnonymizeMaskStore();
        for (int i = 0; i < maskCount; i++) {
            store.put(new AnonymizeMaskStore.SeriesMask("1.2.3." + i, List.of(),
                    List.of(new AnonymizeMaskStore.Rect(0, 0, 8, 8))));
        }
        return new AnonymizeController(null, store);
    }

    private static AnonymizeConfig cleanPixelCfg() {
        AnonymizeConfig cfg = new AnonymizeConfig();
        cfg.addOption(AnonymizeConfig.Option.CleanPixelData);
        return cfg;
    }

    @Test
    void cleanPixelData_withNoRegisteredMask_isRejectedBeforeWriting() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> controllerWithMasks(0).requireBurnableIfCleanPixelData(cleanPixelCfg(), true));
        assertEquals(HttpStatus.CONFLICT, e.getStatusCode(),
                "マスクが無いまま出力すると焼き込み文字が残るので中止する");
    }

    @Test
    void cleanPixelData_withoutBurnInFlag_isRejected() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> controllerWithMasks(1).requireBurnableIfCleanPixelData(cleanPixelCfg(), false));
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatusCode(), "設定と出力が食い違うものは通さない");
    }

    @Test
    void cleanPixelData_withMask_isAccepted() {
        assertDoesNotThrow(() -> controllerWithMasks(1).requireBurnableIfCleanPixelData(cleanPixelCfg(), true));
    }

    @Test
    void withoutCleanPixelData_maskCountDoesNotMatter() {
        assertDoesNotThrow(() -> controllerWithMasks(0)
                .requireBurnableIfCleanPixelData(new AnonymizeConfig(), false));
    }

    // ------------------------------------------------------------------------
    // 既定プロファイル
    // ------------------------------------------------------------------------

    @Test
    void builtinProfiles_containNoConflictingDateOptions() {
        // research プロファイルは ModifiedDates だけを持つ（Full Dates は含まない）ので、
        // ボタン 1 つで 400 になる状態に入らない。将来の編集ミスをここで固定する。
        for (AnonymizeController.ProfileDto p : new AnonymizeController(null, null).profiles()) {
            boolean both = p.options().contains(FULL) && p.options().contains(MOD);
            assertTrue(!both, "プロファイル " + p.name() + " が排他の日付オプションを両方持っている");
        }
    }
}
