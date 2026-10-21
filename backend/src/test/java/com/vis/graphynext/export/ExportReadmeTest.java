package com.vis.graphynext.export;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** README.txt は受け取る人が読む文章。起動方法・DICOM の場所・非診断の注意・署名が、必要なときに入ることを確かめる。 */
class ExportReadmeTest {

    private static final ExportService.Summary SUMMARY = new ExportService.Summary(1, 2, 3, 4);

    private static String readme(boolean dicomDir, boolean viewer) {
        return ExportService.readme(new ExportService.Options(dicomDir, viewer, true), SUMMARY);
    }

    @Test
    void withViewerExplainsLaunchersLocationNoticeAndSignature() {
        String t = readme(true, true);
        for (String must : new String[] {
                "START-VIEWER.bat", "START-VIEWER.command", "sh START-VIEWER.sh", // 起動方法（3 OS）
                "START-VIEWER.html", // 案内ページ
                "「DICOM」フォルダ", "DICOMDIR", "DICOM/<PatientID>", // DICOM の場所（日・英）
                "非診断用", "not for diagnostic use", // 非診断の注意（日・英）
                "Visionary Imaging Services, Inc.", // 署名
                "患者 1 名", "画像 4 枚", "4 image(s)"}) { // 件数
            assertTrue(t.contains(must), "README に「" + must + "」が無い:\n" + t);
        }
        assertTrue(t.trim().endsWith("Visionary Imaging Services, Inc."), "署名が末尾にある");
    }

    /** 補足行（案内ページ）は、手順 1〜3 の流れを切らないよう、手順 3 の後ろ・注記の前に置く。 */
    @Test
    void htmlHintComesAfterStepThreeAndBeforeTheNotes() {
        String t = readme(true, true);
        String[][] langs = {
                {"  2. ブラウザが開き", "  3. 終わるときは", "START-VIEWER.html を開くと", "画像はこの PC の外へは"},
                {"  2. Your browser opens", "  3. To finish", "Open START-VIEWER.html", "Images are never sent"}};
        for (String[] k : langs) {
            int s2 = t.indexOf(k[0]);
            int s3 = t.indexOf(k[1]);
            int hint = t.indexOf(k[2]);
            int note = t.indexOf(k[3]);
            assertTrue(s2 >= 0 && s3 >= 0 && hint >= 0 && note >= 0, "必要な行が無い: " + String.join(" / ", k));
            assertTrue(s3 < hint && hint < note, "補足行が手順 3 の後ろ・注記の前にない: " + k[2]);
            assertFalse(s2 < hint && hint < s3, "補足行が手順 2 と 3 の間に入っている: " + k[2]);
        }
    }

    @Test
    void withoutViewerDoesNotMentionTheLauncherButKeepsNoticeAndSignature() {
        String t = readme(true, false);
        assertFalse(t.contains("START-VIEWER"), "ビューアを同梱しないのに起動方法が出ている:\n" + t);
        assertFalse(t.contains("付属のビューア"), t);
        assertTrue(t.contains("非診断用") && t.contains("not for diagnostic use"), t);
        assertTrue(t.contains("Visionary Imaging Services, Inc."), t);
        assertTrue(t.contains("DICOMDIR"), "DICOMDIR を付けたときは説明が出る");
    }

    @Test
    void withoutDicomDirDoesNotExplainIt() {
        String t = readme(false, false);
        assertFalse(t.contains("DICOMDIR"), "DICOMDIR を付けていないのに説明が出ている:\n" + t);
        assertTrue(t.contains("「DICOM」フォルダ"), "画像の場所は常に出る");
    }
}
