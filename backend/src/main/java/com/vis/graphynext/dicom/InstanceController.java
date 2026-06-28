package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;

/**
 * インスタンス（SOP）単体のピクセル配信。standalone 2D ビューア用。
 *
 * <p>ローカル索引が持つ {@code file:} URI のファイルを Part-10（{@code application/dicom}）で返す。
 * フロントは {@code wadouri:<base>/api/instances/{sop}/file} として Cornerstone3D に読ませる。
 *
 * <p>web モードでは画像は PACS の WADO から直接取得するため、このエンドポイントは使わない
 * （索引が無いので 404 を返す）。
 */
@RestController
@RequestMapping("/api/instances")
public class InstanceController {

    /** DICOM Part-10 の MIME タイプ。 */
    private static final MediaType APPLICATION_DICOM = MediaType.parseMediaType("application/dicom");

    private final DicomStorageService storage;

    public InstanceController(DicomStorageService storage) {
        this.storage = storage;
    }

    @GetMapping("/{sopUid}/file")
    public ResponseEntity<Resource> file(@PathVariable String sopUid) {
        Path path = storage.resolveInstanceFile(sopUid);
        if (path == null) {
            return ResponseEntity.notFound().build();
        }
        Resource body = new FileSystemResource(path);
        return ResponseEntity.ok()
                .contentType(APPLICATION_DICOM)
                // wadouri は Range 要求しないが、キャッシュ等のため素直に返す。
                .header(HttpHeaders.CACHE_CONTROL, "private, max-age=3600")
                .body(body);
    }
}
