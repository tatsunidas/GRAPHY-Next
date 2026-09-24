/*
 * GRAPHY-Next Benchmark
 * Copyright (C) 2026 Visionary Imaging Services, Inc.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * GNBP のファントムを、**動いている GRAPHY の保管庫へ入れる**ための最小の C-STORE SCU。
 *
 * ファントム生成器は DICOM ファイルを書き出すだけで、保管庫（H2 索引 ＋ FS）には入らない。
 * standalone の backend にはファイルを受け取る HTTP の口が無く（`DicomStorageService.ingest()`
 * を呼べるのは DIMSE の C-STORE SCP と Q/R の retrieve だけ）、D&D 取り込みも未移植なので、
 * **DIMSE で送るのが唯一の経路**である。
 *
 * dcm4che の CLI（storescu）を別途入れなくて済むよう、backend が既に依存している
 * dcm4che のクラスだけで書いてある。JDK 21 以降なら単一ファイルのまま実行できる。
 *
 * <pre>
 *   bash bench/store-scu.sh phantom/GNBP-5N-t20-id-tex phantom/GNBP-5N-t25-id-tex
 * </pre>
 *
 * ⚠ 送り先は既定で `GRAPHYNEXT@127.0.0.1:11112`（`application.yml` の `local-ae-title` と
 * `application-standalone.yml` の SCP ポート）。**アプリが起動している必要がある。**
 */
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.ApplicationEntity;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Connection;
import org.dcm4che3.net.Device;
import org.dcm4che3.net.DataWriterAdapter;
import org.dcm4che3.net.pdu.AAssociateRQ;
import org.dcm4che3.net.pdu.PresentationContext;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ExecutorService;

public final class StoreScu {

    private static String host = "127.0.0.1";
    private static int port = 11112;
    private static String calledAet = "GRAPHYNEXT";
    private static String callingAet = "GNBP";

    public static void main(String[] args) throws Exception {
        List<Path> files = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--host" -> host = args[++i];
                case "--port" -> port = Integer.parseInt(args[++i]);
                case "--called" -> calledAet = args[++i];
                case "--calling" -> callingAet = args[++i];
                default -> collect(Path.of(args[i]), files);
            }
        }
        if (files.isEmpty()) {
            System.err.println("usage: StoreScu [--host H] [--port P] [--called AET] [--calling AET] <file|dir>...");
            System.exit(2);
        }

        // 送るものの SOP Class と**転送構文**を先に集める。
        // **Presentation Context は接続前に宣言する必要がある**ので、ここを省くと
        // 「接続できたのに送れない」形で失敗する。
        //
        // 🔴 **転送構文をファイルごとに見ること。** 以前はここで ExplicitVRLittleEndian しか
        //    提案せず、圧縮ファイルも「非圧縮」と名乗って送っていた。受信側は
        //    ネゴシエートされた構文を正直に記録するので、**保管された DICOM は
        //    「非圧縮」と書かれているのに画素はカプセル化 JPEG のまま**になる。
        //    どのビューワで開いても画素として読めず、GRAPHY では真っ黒になった
        //    （Rubo の XA で実際に起きた・2026-09-21）。
        //    **エラーも警告も出ない**ので、気付くまでに時間がかかる壊れ方である。
        Map<String, Set<String>> tsByClass = new LinkedHashMap<>();
        Map<Path, String> tsByFile = new LinkedHashMap<>();
        for (Path f : files) {
            String cuid = sopClassOf(f);
            String ts = transferSyntaxOf(f);
            tsByFile.put(f, ts);
            tsByClass.computeIfAbsent(cuid, k -> new LinkedHashSet<>()).add(ts);
        }

        Device device = new Device("gnbp-storescu");
        Connection local = new Connection();
        ApplicationEntity ae = new ApplicationEntity(callingAet);
        device.addConnection(local);
        device.addApplicationEntity(ae);
        ae.addConnection(local);

        ExecutorService executor = Executors.newCachedThreadPool();
        ScheduledExecutorService scheduled = Executors.newSingleThreadScheduledExecutor();
        device.setExecutor(executor);
        device.setScheduledExecutor(scheduled);

        Connection remote = new Connection();
        remote.setHostname(host);
        remote.setPort(port);

        AAssociateRQ rq = new AAssociateRQ();
        rq.setCalledAET(calledAet);
        rq.setCallingAET(callingAet);
        int pcid = 1;
        for (Map.Entry<String, Set<String>> e : tsByClass.entrySet()) {
            // ファイル本来の構文を**必ず先頭で**提案し、非圧縮は保険として添える
            // （中身が非圧縮のときだけ使われる）。
            Set<String> offer = new LinkedHashSet<>(e.getValue());
            offer.add(UID.ExplicitVRLittleEndian);
            offer.add(UID.ImplicitVRLittleEndian);
            rq.addPresentationContext(new PresentationContext(pcid, e.getKey(),
                    offer.toArray(new String[0])));
            pcid += 2;
        }

        System.out.printf("%d file(s) -> %s@%s:%d%n", files.size(), calledAet, host, port);
        int ok = 0;
        int failed = 0;
        try {
            Association as = ae.connect(remote, rq);
            for (Path f : files) {
                try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                    Attributes fmi = in.readFileMetaInformation();
                    Attributes data = in.readDataset();
                    String cuid = fmi != null ? fmi.getString(Tag.MediaStorageSOPClassUID)
                            : data.getString(Tag.SOPClassUID);
                    String iuid = fmi != null ? fmi.getString(Tag.MediaStorageSOPInstanceUID)
                            : data.getString(Tag.SOPInstanceUID);
                    // 🔴 **ファイル本来の転送構文で送る。** 変換はしない（画素はそのまま渡す）。
                    //    受け入れられなければ dcm4che が例外を投げるので、**黙って別の構文を
                    //    名乗ることは無い**——壊れたものを保管するより、送れないほうがよい。
                    String ts = tsByFile.getOrDefault(f, UID.ExplicitVRLittleEndian);
                    as.cstore(cuid, iuid, 1, new DataWriterAdapter(data), ts);
                    as.waitForOutstandingRSP();
                    ok++;
                    System.out.printf("  ok  %s  (%s) [%s]%n", f.getFileName(), describe(data),
                            shortTs(tsByFile.get(f)));
                } catch (Exception e) {
                    failed++;
                    System.out.printf("  NG  %s  %s%n", f.getFileName(), e);
                }
            }
            as.release();
            as.waitForSocketClose();
        } finally {
            executor.shutdown();
            scheduled.shutdown();
        }
        System.out.printf("stored %d, failed %d%n", ok, failed);
        if (failed > 0) System.exit(1);
    }

    private static void collect(Path p, List<Path> out) throws IOException {
        if (Files.isDirectory(p)) {
            try (var s = Files.list(p)) {
                for (Path child : s.sorted().toList()) collect(child, out);
            }
        } else if (p.getFileName().toString().toLowerCase().endsWith(".dcm")) {
            out.add(p);
        }
    }

    private static String sopClassOf(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            Attributes fmi = in.readFileMetaInformation();
            if (fmi != null && fmi.getString(Tag.MediaStorageSOPClassUID) != null) {
                return fmi.getString(Tag.MediaStorageSOPClassUID);
            }
            return in.readDataset().getString(Tag.SOPClassUID);
        }
    }

    /** ファイル本来の転送構文（File Meta から。無ければ非圧縮とみなす）。 */
    private static String transferSyntaxOf(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            Attributes fmi = in.readFileMetaInformation();
            String ts = fmi != null ? fmi.getString(Tag.TransferSyntaxUID) : null;
            return ts != null ? ts : UID.ExplicitVRLittleEndian;
        }
    }

    /** 表示用の短縮（どの構文で送ったかを画面に出すため）。 */
    private static String shortTs(String ts) {
        if (ts == null) return "?";
        String name = UID.nameOf(ts);
        return name != null ? name : ts;
    }

    private static String describe(Attributes data) {
        return String.format("%s / %s / %s",
                String.valueOf(data.getString(Tag.PatientID)),
                String.valueOf(data.getString(Tag.Modality)),
                String.valueOf(data.getString(Tag.SeriesDescription)));
    }

    private StoreScu() {
    }
}
