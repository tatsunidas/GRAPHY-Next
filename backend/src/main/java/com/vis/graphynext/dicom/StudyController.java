package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * スタディ一覧の REST。モードに依らずフロントエンドは {@code GET /api/studies} を叩く。
 * <ul>
 *   <li>web: {@link WebDicomDataService} 経由で外部 PACS の QIDO-RS。</li>
 *   <li>standalone: {@link DicomStorageService} のローカル索引（H2）集計。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api")
public class StudyController {

    private final DicomStorageService storage;
    private final ObjectProvider<WebDicomDataService> webProvider;

    public StudyController(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider) {
        this.storage = storage;
        this.webProvider = webProvider;
    }

    @GetMapping("/studies")
    public List<StudyDto> studies() {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            return web.searchStudies(Map.of()).stream().map(StudyController::fromAttributes).toList();
        }
        return storage.listStudies();
    }

    private static StudyDto fromAttributes(Attributes a) {
        return new StudyDto(
                a.getString(Tag.StudyInstanceUID),
                a.getString(Tag.PatientID),
                a.getString(Tag.PatientName),
                a.getInt(Tag.NumberOfStudyRelatedInstances, 0));
    }
}
