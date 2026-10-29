/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.automator;

import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.plugin.store.PluginDocumentService;
import com.vis.graphynext.plugin.store.SavePluginDocumentRequest;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.roi.RoiDocumentService;
import com.vis.graphynext.roi.SaveRoiDocumentRequest;
import com.vis.graphynext.settings.SettingsService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * automator の reset が**症例データを本当に全部消すか**を検証する。
 *
 * <p>ROI（幾何注釈）の保存を消し忘れていたため、検証スパイクが前回実行の ROI を復元して
 * テストが汚染された（2026-07-30 の実機検証で判明）。実運用でも「症例を消したのに計測が残る」
 * という挙動になるので、回帰させないようテストで固定する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:automatorreset;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "GRAPHY_AUTOMATOR=1"
        })
class AutomatorServiceResetTest {

    @Autowired
    AutomatorService automator;

    @Autowired
    RoiDocumentService roiService;

    @Autowired
    RoiDocumentRepository roiRepo;

    @Autowired
    com.vis.graphynext.roi.RoiMaskDocumentRepository maskRepo;

    @Autowired
    PluginDocumentService pluginService;

    @Autowired
    PluginDocumentRepository pluginRepo;

    @Autowired
    SettingsService settings;

    private static final String JSON = "{\"schema\":1,\"rois\":[{\"roiUid\":\"u1\",\"tool\":\"Length\"}]}";

    @Test
    void reset_deletesXaCalibrationsButKeepsRealSettings() {
        // 🚨 XA の空間校正は「環境設定」ではなく症例に紐づくデータ。消し残すと、
        //    前の実行で確定した校正が次の実行に効いて**「未校正なら px 表示」が黙って通る**。
        settings.putAll(java.util.Map.of(
                SettingsService.XA_CALIBRATION_PREFIX + "1.2.3",
                "{\"v\":1,\"mmPerPx\":0.208,\"method\":\"catheter\"}",
                SettingsService.XA_CALIBRATION_PREFIX + "1.2.4",
                "{\"v\":1,\"mmPerPx\":0.3,\"method\":\"ruler\"}",
                SettingsService.DEBUG_MODE_KEY, "true"));

        AutomatorService.ResetResult r = automator.reset();

        assertEquals(2, r.deletedXaCalibrations(), "校正の削除件数が返る");
        assertNull(settings.getAll().get(SettingsService.XA_CALIBRATION_PREFIX + "1.2.3"));
        assertNull(settings.getAll().get(SettingsService.XA_CALIBRATION_PREFIX + "1.2.4"));
        // 環境設定そのものは消さない（ここまで消すと検証環境の前提が毎回崩れる）。
        assertEquals("true", settings.getAll().get(SettingsService.DEBUG_MODE_KEY));
    }

    @Autowired
    com.vis.graphynext.importer.ImportWatchRepository importWatchRepo;

    @Test
    void reset_deletesImportWatchSettingsAndLedger() {
        // 監視取り込みを有効にしたまま次の実行へ持ち越すと、前の実行の台帳が「取り込み済み」を覚えていて
        // 検証が黙って汚染される。
        settings.putAll(java.util.Map.of(
                SettingsService.IMPORT_WATCH_PREFIX + "enabled", "true",
                SettingsService.IMPORT_WATCH_PREFIX + "folder", "/some/folder"));
        importWatchRepo.save(new com.vis.graphynext.importer.ImportWatchItem("/some/folder/a.dcm", 1, 2, "IMPORTED", 3, null));
        assertEquals(1, importWatchRepo.count(), "前提: 台帳がある");

        automator.reset();

        assertEquals(0, importWatchRepo.count(), "台帳が消える");
        assertNull(settings.getAll().get(SettingsService.IMPORT_WATCH_PREFIX + "enabled"));
        assertNull(settings.getAll().get(SettingsService.IMPORT_WATCH_PREFIX + "folder"));
    }

    @Test
    void reset_deletesSavedPaintedRoiMasks() {
        // 塗り ROI（別テーブル）も初期化の対象。残すと次の実行の復元に前回のマスクが混ざる。
        maskRepo.save(new com.vis.graphynext.roi.RoiMaskDocument("m-reset", "PAT-RESET", "1.2.3", "{\"patientKey\":\"PAT-RESET\"}", new byte[] {1}, 1));
        assertEquals(1, maskRepo.count(), "前提: 塗り ROI の保存がある");

        automator.reset();

        assertEquals(0, maskRepo.count(), "塗り ROI の保存が消えている");
    }

    @Test
    void reset_deletesRoiDocuments() {
        roiService.save("PAT-RESET", new SaveRoiDocumentRequest(JSON, 1, null));
        assertEquals(1, roiRepo.count(), "前提: ROI 保存がある");

        AutomatorService.ResetResult r = automator.reset();

        assertEquals(1, r.deletedRoiDocuments(), "削除件数が返る");
        assertEquals(0, roiRepo.count(), "ROI 保存が消えている");
        // 読み直しても空の器（＝復元するものが無い）。
        assertNull(roiService.get("PAT-RESET").json());
    }

    @Test
    void reset_deletesTombstoneOnlyDocuments() {
        // 全 ROI を削除した後の「墓標だけのドキュメント」も残してはいけない
        // （残ると、次に同じ患者で描いた ROI が墓標に載っていた UID と混ざる余地ができる）。
        var v0 = roiService.save("PAT-TOMB", new SaveRoiDocumentRequest(JSON, 1, null));
        roiService.save(
                "PAT-TOMB",
                new SaveRoiDocumentRequest(
                        "{\"schema\":1,\"rois\":[],\"deleted\":[{\"roiUid\":\"u1\",\"at\":\"2026-07-30T00:00:00Z\"}]}",
                        0,
                        v0.version()));
        assertEquals(1, roiRepo.count());

        automator.reset();

        assertEquals(0, roiRepo.count(), "墓標だけのドキュメントも消える");
        assertNull(roiService.get("PAT-TOMB").json());
    }

    @Test
    void reset_deletesPluginDocuments() {
        // プラグイン保存領域（H8）も消す。消し残すと「症例を消したのに評価記録が残る」状態になり、
        // 検証では前回の実行の記録が次の実行に混ざる（ROI 保存で実際に起きた）。
        pluginService.save("lesion-evanesco", "PAT-RESET",
                new SavePluginDocumentRequest("{\"schema\":1,\"timepoints\":[]}", null));
        assertEquals(1, pluginRepo.count(), "前提: プラグイン保存がある");

        AutomatorService.ResetResult r = automator.reset();

        assertEquals(1, r.deletedPluginDocuments(), "削除件数が返る");
        assertEquals(0, pluginRepo.count(), "プラグイン保存が消えている");
        assertNull(pluginService.get("lesion-evanesco", "PAT-RESET").json());
    }

    @Test
    void reset_keepPluginStore_keepsPluginDocumentsButStillDeletesTheRest() {
        // 検証用ランチャーの起動をまたいで、プラグインの解析状態の保存を残す指定。他（ROI など）は従来どおり消える。
        pluginService.save("angio-quant", "PAT-KEEP",
                new SavePluginDocumentRequest("{\"schema\":1,\"dual\":{}}", null));
        roiService.save("PAT-KEEP", new SaveRoiDocumentRequest(JSON, 1, null));
        assertEquals(1, pluginRepo.count(), "前提: プラグイン保存がある");
        assertEquals(1, roiRepo.count(), "前提: ROI 保存がある");

        AutomatorService.ResetResult r = automator.reset(true);

        assertEquals(0, r.deletedPluginDocuments(), "消していないので 0 件");
        assertEquals(1, pluginRepo.count(), "プラグイン保存が残っている");
        assertEquals("{\"schema\":1,\"dual\":{}}", pluginService.get("angio-quant", "PAT-KEEP").json());
        assertEquals(0, roiRepo.count(), "★負例: ROI 保存は消えている（残すのはプラグイン保存だけ）");

        automator.reset(false); // 後始末（他のテストへ持ち越さない）
        assertEquals(0, pluginRepo.count(), "指定なし（既定）では従来どおり消える");
    }

    @Test
    void reset_isIdempotent() {
        automator.reset();
        AutomatorService.ResetResult again = automator.reset();
        assertEquals(0, again.deletedRoiDocuments());
        assertEquals(0, again.deletedPluginDocuments());
    }
}
