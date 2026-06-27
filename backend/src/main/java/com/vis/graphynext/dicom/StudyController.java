package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * スタディ/シリーズ/インスタンスのナビゲーション REST。モードに依らずフロントは同じ URL を叩く。
 * <ul>
 *   <li>web: {@link WebDicomDataService}（QIDO-RS）。</li>
 *   <li>standalone: {@link DicomStorageService} のローカル索引（H2）。</li>
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
            return web.searchStudies(Map.of()).stream().map(StudyController::studyOf).toList();
        }
        return storage.listStudies();
    }

    @GetMapping("/studies/{studyUid}/series")
    public List<SeriesDto> series(@PathVariable String studyUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            return web.searchSeries(studyUid, Map.of()).stream().map(StudyController::seriesOf).toList();
        }
        return storage.listSeries(studyUid);
    }

    @GetMapping("/studies/{studyUid}/series/{seriesUid}/instances")
    public List<InstanceDto> instances(@PathVariable String studyUid, @PathVariable String seriesUid) {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            return web.searchInstances(studyUid, seriesUid, Map.of()).stream()
                    .map(StudyController::instanceOf).toList();
        }
        return storage.listInstances(studyUid, seriesUid);
    }

    // --- QIDO Attributes -> DTO ---

    private static StudyDto studyOf(Attributes a) {
        return new StudyDto(
                a.getString(Tag.StudyInstanceUID),
                a.getString(Tag.PatientID),
                a.getString(Tag.PatientName),
                a.getString(Tag.StudyDate),
                a.getString(Tag.StudyDescription),
                a.getString(Tag.ModalitiesInStudy),
                a.getInt(Tag.NumberOfStudyRelatedInstances, 0));
    }

    private static SeriesDto seriesOf(Attributes a) {
        return new SeriesDto(
                a.getString(Tag.SeriesInstanceUID),
                a.getString(Tag.Modality),
                a.getInt(Tag.SeriesNumber, 0),
                a.getString(Tag.SeriesDescription),
                a.getInt(Tag.NumberOfSeriesRelatedInstances, 0));
    }

    private static InstanceDto instanceOf(Attributes a) {
        return new InstanceDto(
                a.getString(Tag.SOPInstanceUID),
                a.getInt(Tag.InstanceNumber, 0),
                a.getString(Tag.SOPClassUID));
    }
}
