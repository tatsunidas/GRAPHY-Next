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
                "「DICOM」フォルダ", "DICOMDIR", "DICOM/<PatientID>", // DICOM の場所（日・英）
                "非診断用", "not for diagnostic use", // 非診断の注意（日・英）
                "Visionary Imaging Services, Inc.", // 署名
                "患者 1 名", "画像 4 枚", "4 image(s)"}) { // 件数
            assertTrue(t.contains(must), "README に「" + must + "」が無い:\n" + t);
        }
        assertTrue(t.trim().endsWith("Visionary Imaging Services, Inc."), "署名が末尾にある");
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
