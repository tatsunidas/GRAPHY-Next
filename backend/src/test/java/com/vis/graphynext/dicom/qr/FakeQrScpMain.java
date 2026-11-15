/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import org.dcm4che3.data.ElementDictionary;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * 偽の Q/R SCP を単独のプロセスとして起動する（実アプリの検査・手元の再現用）。
 *
 * <pre>
 * java -cp target/test-classes:target/classes:&lt;依存&gt; com.vis.graphynext.dicom.qr.FakeQrScpMain \
 *      &lt;port&gt; &lt;AE&gt; &lt;NORMAL|NO_QR|ERROR_STATUS|DROP_ON_KEYS&gt; [errorStatusHex|dropKeywords,カンマ区切り] [retrieve:true|false] [moveDest,…]
 * 例（中継サーバーの再現）: 4000 RELAY1 DROP_ON_KEYS NumberOfStudyRelatedSeries,NumberOfStudyRelatedInstances false
 * </pre>
 */
public final class FakeQrScpMain {

    private FakeQrScpMain() {
    }

    public static void main(String[] a) throws Exception {
        int port = Integer.parseInt(a[0]);
        FakeQrScp.Behavior b = FakeQrScp.Behavior.valueOf(a[2]);
        int err = 0;
        Set<Integer> drop = new HashSet<>();
        if (a.length > 3) {
            if (b == FakeQrScp.Behavior.ERROR_STATUS) {
                err = Integer.parseInt(a[3], 16);
            } else {
                Arrays.stream(a[3].split(",")).filter(s -> !s.isBlank())
                        .forEach(k -> drop.add(ElementDictionary.tagForKeyword(k.trim(), null)));
            }
        }
        boolean retrieve = a.length > 4 && Boolean.parseBoolean(a[4]);
        Set<String> dests = a.length > 5 ? new HashSet<>(Arrays.asList(a[5].split(","))) : null;
        FakeQrScp s = FakeQrScp.start(a[1], b, false, true, err, drop, retrieve, dests, port);
        System.out.println("fake Q/R SCP: " + a[1] + " :" + s.port + " " + b + " (Ctrl-C で終了)");
        Thread.currentThread().join();
    }
}
