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
    PluginDocumentService pluginService;

    @Autowired
    PluginDocumentRepository pluginRepo;

    private static final String JSON = "{\"schema\":1,\"rois\":[{\"roiUid\":\"u1\",\"tool\":\"Length\"}]}";

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
    void reset_isIdempotent() {
        automator.reset();
        AutomatorService.ResetResult again = automator.reset();
        assertEquals(0, again.deletedRoiDocuments());
        assertEquals(0, again.deletedPluginDocuments());
    }
}
