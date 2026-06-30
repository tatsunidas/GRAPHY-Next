/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nondicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Path;

/**
 * Encapsulated Document（PDF 等）の中身を取り出して配信する。
 *
 * <p>{@code GET /api/instances/{sop}/document} → {@code EncapsulatedDocument(0042,0011)} のバイト列を
 * {@code MIMETypeOfEncapsulatedDocument(0042,0012)} の Content-Type で返す。Encapsulated PDF を
 * ブラウザ/Electron で開く（インライン）／ダウンロード（{@code ?download=true}）するために使う。
 * ピクセルを持たない SOP（PDF）は 2D 画像ビューアで表示できないため、本経路で閲覧する。
 */
@RestController
@RequestMapping("/api/instances")
public class EncapsulatedDocumentController {

    private static final Logger log = LoggerFactory.getLogger(EncapsulatedDocumentController.class);

    private final DicomStorageService storage;

    public EncapsulatedDocumentController(DicomStorageService storage) {
        this.storage = storage;
    }

    @GetMapping("/{sopUid}/document")
    public ResponseEntity<byte[]> document(@PathVariable String sopUid,
                                           @RequestParam(required = false, defaultValue = "false") boolean download) {
        Path path = storage.resolveInstanceFile(sopUid);
        if (path == null) {
            return ResponseEntity.notFound().build();
        }
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.YES); // 文書本体（OB バルク）を読み込む
            ds = in.readDatasetUntilPixelData();
        } catch (IOException e) {
            log.warn("document: 読取失敗 {}", sopUid, e);
            return ResponseEntity.notFound().build();
        }
        byte[] doc;
        try {
            doc = ds.getBytes(Tag.EncapsulatedDocument);
        } catch (IOException e) {
            log.warn("document: EncapsulatedDocument 取得失敗 {}", sopUid, e);
            return ResponseEntity.notFound().build();
        }
        if (doc == null || doc.length == 0) {
            return ResponseEntity.notFound().build(); // カプセル化文書ではない
        }
        String mime = ds.getString(Tag.MIMETypeOfEncapsulatedDocument, "application/octet-stream");
        String title = ds.getString(Tag.DocumentTitle, sopUid);
        String filename = sanitize(title) + extOf(mime);
        String disposition = (download ? "attachment" : "inline") + "; filename=\"" + filename + "\"";
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(mime))
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition)
                .body(doc);
    }

    private static String extOf(String mime) {
        if (mime == null) {
            return "";
        }
        return switch (mime.toLowerCase()) {
            case "application/pdf" -> ".pdf";
            case "text/xml", "application/xml" -> ".xml";
            case "text/plain" -> ".txt";
            default -> "";
        };
    }

    private static String sanitize(String s) {
        String t = (s == null ? "document" : s).replaceAll("[^0-9A-Za-z._-]", "_");
        if (t.isEmpty()) {
            t = "document";
        }
        return t.length() <= 64 ? t : t.substring(0, 64);
    }
}
