/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.DataWriter;
import org.dcm4che3.net.DataWriterAdapter;
import org.dcm4che3.net.Dimse;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicRetrieveTask;
import org.dcm4che3.net.service.DicomServiceException;
import org.dcm4che3.net.service.InstanceLocator;

import java.util.List;
import java.util.Set;

/**
 * 保管庫のファイルを C-STORE で返す取得（C-MOVE／C-GET）の共通部分。
 * 転送構文の選び方は DICOM Send（{@link DicomStoreScu}）と同じ: 保存の構文を相手が受けるならそれ、
 * 受けない可逆圧縮はコーデックがあれば Explicit VR LE へ復号、どちらも無ければその画像を失敗として数える。
 * 送り先の接続 {@code storeas} は、C-MOVE では宛先への別接続、C-GET では要求を受けた接続そのもの。
 */
abstract class StoredFileRetrieveTask extends BasicRetrieveTask<InstanceLocator> {

    private final PixelCodec codec;

    StoredFileRetrieveTask(Dimse rq, Association as, PresentationContext pc, Attributes cmd, List<InstanceLocator> insts,
                           Association storeas, PixelCodec codec) {
        super(rq, as, pc, cmd, insts, storeas);
        this.codec = codec;
    }

    @Override
    protected String selectTransferSyntaxFor(Association storeas, InstanceLocator inst) throws Exception {
        if (inst.uri == null) {
            throw new DicomServiceException(Status.ProcessingFailure, "ファイルを読めません: " + inst.iuid);
        }
        Set<String> accepted = storeas.getTransferSyntaxesFor(inst.cuid);
        if (inst.tsuid != null && accepted.contains(inst.tsuid)) {
            return inst.tsuid;
        }
        if (codec != null && DicomStoreScu.isLosslessStored(inst.tsuid) && accepted.contains(UID.ExplicitVRLittleEndian)) {
            return UID.ExplicitVRLittleEndian;
        }
        throw new DicomServiceException(Status.ProcessingFailure,
                "宛先が転送構文 " + inst.tsuid + " を受け付けません: " + inst.iuid);
    }

    @Override
    protected DataWriter createDataWriter(InstanceLocator inst, String tsuid) throws Exception {
        // ファイルは送る前に読み切って閉じる（ネットワーク I/O 中にファイルを掴まない。Windows のロック対策）
        if (tsuid.equals(inst.tsuid)) {
            try (DicomInputStream din = new DicomInputStream(inst.getFile())) {
                din.readFileMetaInformation();
                return new DataWriterAdapter(din.readDataset());
            }
        }
        PixelCodec.Uncompressed u = codec.toUncompressed(inst.getFile().toPath());
        if (u == null) {
            throw new DicomServiceException(Status.ProcessingFailure, "圧縮画像を復号できません: " + inst.iuid);
        }
        return new DataWriterAdapter(u.ds());
    }
}
