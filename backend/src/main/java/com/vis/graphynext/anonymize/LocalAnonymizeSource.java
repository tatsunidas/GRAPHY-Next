/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.store.DicomInstance;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** standalone: 索引（{@link DicomInstance}）が指すローカルファイルを読む。 */
class LocalAnonymizeSource implements AnonymizeSource {

    private final List<Item> items = new ArrayList<>();
    private final Map<Item, DicomInstance> byItem = new HashMap<>();
    private final Function<DicomInstance, Path> fileOf;

    LocalAnonymizeSource(List<DicomInstance> instances, Function<DicomInstance, Path> fileOf) {
        this.fileOf = fileOf;
        for (DicomInstance i : instances) {
            Item it = new Item(i.getStudyInstanceUid(), i.getSeriesInstanceUid(), i.getSopInstanceUid(),
                    i.getPatientId());
            items.add(it);
            byItem.put(it, i);
        }
    }

    @Override
    public List<Item> list() {
        return items;
    }

    @Override
    public Opened open(Item item) throws IOException {
        Path src = fileOf.apply(byItem.get(item));
        if (src == null) {
            throw new Missing("ファイル無し: " + item.sopUid());
        }
        try (DicomInputStream in = new DicomInputStream(src.toFile())) {
            // 🔴 URI（YES ではなく）。PixelData を**元ファイルへの参照**として持たせる。
            //    圧縮画素の伸長（PixelCodec）は Decompressor が BulkData を要求するため、
            //    YES で読んで byte[] にしてしまうと ClassCastException になる。
            //    非圧縮の経路では getBytes() が従来どおり実体を返すので影響しない。
            in.setIncludeBulkData(IncludeBulkData.URI);
            in.readFileMetaInformation();
            Attributes ds = in.readDataset(-1, -1);
            return new Opened(ds, in.getTransferSyntax(), null);
        }
    }
}
