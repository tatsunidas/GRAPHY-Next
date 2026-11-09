/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import com.vis.graphynext.dicom.DicomScpServer;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCFindSCP;
import org.dcm4che3.net.service.BasicQueryTask;
import org.dcm4che3.net.service.DicomServiceException;
import org.dcm4che3.net.service.QueryTask;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** 試験用の Modality Worklist SCP（in-process）。予約開始日・ステーション AE・モダリティの一致で応える。 */
final class FakeMwl implements AutoCloseable {

    record Entry(String patientId, String date, String modality, String station) {
    }

    final int port;
    private final DicomScpServer server;

    FakeMwl(String ae, List<Entry> entries) {
        this.port = FakePacs.freePort();
        this.server = new DicomScpServer(ae, "127.0.0.1", port);
        server.addService(new BasicCFindSCP(UID.ModalityWorklistInformationModelFind) {
            @Override
            protected QueryTask calculateMatches(Association as, PresentationContext pc, Attributes rq, Attributes keys)
                    throws DicomServiceException {
                Attributes sps = keys.getNestedDataset(Tag.ScheduledProcedureStepSequence);
                List<Attributes> out = new ArrayList<>();
                for (Entry e : entries) {
                    if (sps != null) {
                        if (!matches(sps.getString(Tag.ScheduledProcedureStepStartDate), e.date)
                                || !matches(sps.getString(Tag.ScheduledStationAETitle), e.station)
                                || !matches(sps.getString(Tag.Modality), e.modality)) {
                            continue;
                        }
                    }
                    Attributes a = new Attributes();
                    a.setString(Tag.PatientID, VR.LO, e.patientId);
                    a.setString(Tag.PatientName, VR.PN, "WL^TEST");
                    Sequence seq = a.newSequence(Tag.ScheduledProcedureStepSequence, 1);
                    Attributes item = new Attributes();
                    item.setString(Tag.ScheduledProcedureStepStartDate, VR.DA, e.date);
                    item.setString(Tag.Modality, VR.CS, e.modality);
                    item.setString(Tag.ScheduledStationAETitle, VR.AE, e.station);
                    seq.add(item);
                    out.add(a);
                }
                Iterator<Attributes> it = out.iterator();
                return new BasicQueryTask(as, pc, rq, keys) {
                    @Override
                    protected boolean hasMoreMatches() {
                        return it.hasNext();
                    }

                    @Override
                    protected Attributes nextMatch() {
                        return it.next();
                    }
                };
            }
        }, new TransferCapability(null, UID.ModalityWorklistInformationModelFind, TransferCapability.Role.SCP,
                UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian));
        server.start();
    }

    private static boolean matches(String key, String value) {
        return key == null || key.isEmpty() || key.equals(value);
    }

    @Override
    public void close() {
        server.stop();
    }
}
