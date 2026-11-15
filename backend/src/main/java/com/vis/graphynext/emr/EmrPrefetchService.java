/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

/** 患者の ID が変わったときの、過去検査の先取り（段 2 で実装）。 */
@Service
@Profile("standalone")
public class EmrPrefetchService {

    /**
     * 取り込みの状態。state: idle / finding / retrieving / done / not-found / error。
     * {@code latestReady} は、直近の検査が 2D ビューアで開ける状態か。
     */
    public record FetchState(String state, String patientId, int found, int retrieved, String latestStudyUid,
                             boolean latestReady, String error) {
        public static FetchState idle() {
            return new FetchState("idle", null, 0, 0, null, false, null);
        }
    }

    public FetchState state() {
        return FetchState.idle();
    }

    @EventListener
    void onChanged(EmrPatientChanged e) {
        request(e.patientId(), e.seq());
    }

    public void request(String patientId, long seq) {
        // 段 2 で実装
    }
}
