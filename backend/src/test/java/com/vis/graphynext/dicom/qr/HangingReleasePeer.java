/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * <b>A-RELEASE-RQ に応答しない</b>偽の DICOM 相手（生のソケットで上位層を最小限だけ話す。実例: 応答は返すのに解放を無視する
 * 中継サーバー）。A-ASSOCIATE-RQ に応答（Study Root／Patient Root の FIND を Implicit VR LE で受理）し、C-FIND-RQ に
 * <b>status 0000H だけ</b>（該当なし）を返し、そのあと A-RELEASE-RQ には黙る。クライアントが切るまで、接続は開けたままにする。
 */
final class HangingReleasePeer implements AutoCloseable {

    private static final String IMPLICIT = "1.2.840.10008.1.2";
    private static final String STUDY_ROOT_FIND = "1.2.840.10008.5.1.4.1.2.2.1";
    private static final String PATIENT_ROOT_FIND = "1.2.840.10008.5.1.4.1.2.1.1";

    final int port;
    final String aet;
    /** 受け取った A-RELEASE-RQ の数（応答はしない）。 */
    final AtomicInteger releaseRequests = new AtomicInteger();
    /** 受け取った A-ABORT の数。 */
    final AtomicInteger aborts = new AtomicInteger();
    /** 返した C-FIND-RSP の数。 */
    final AtomicInteger findResponses = new AtomicInteger();

    private final ServerSocket server;
    private final Thread acceptor;
    private final List<Socket> open = new ArrayList<>();
    private volatile boolean closed;
    /** A-ABORT を受けたとき、TCP を閉じるか（規約どおりの相手は閉じる）。閉じない相手は、クライアントを Sta13 で待たせ続ける。 */
    private final boolean closeOnAbort;

    HangingReleasePeer(String aet) throws IOException {
        this(aet, true);
    }

    HangingReleasePeer(String aet, boolean closeOnAbort) throws IOException {
        this.aet = aet;
        this.closeOnAbort = closeOnAbort;
        this.server = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
        this.port = server.getLocalPort();
        this.acceptor = new Thread(this::acceptLoop, "hanging-release-peer");
        this.acceptor.setDaemon(true);
        this.acceptor.start();
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket s = server.accept();
                synchronized (open) {
                    open.add(s);
                }
                Thread t = new Thread(() -> serve(s), "hanging-release-peer-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket s) {
        try (s) {
            DataInputStream in = new DataInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            int acceptedPc = -1;
            while (true) {
                int type = in.readUnsignedByte();
                in.readUnsignedByte();
                byte[] body = new byte[in.readInt()];
                in.readFully(body);
                switch (type) {
                    case 0x01 -> { // A-ASSOCIATE-RQ
                        Assoc a = acAndAcceptedPc(body);
                        acceptedPc = a.acceptedPc;
                        out.write(a.ac);
                        out.flush();
                    }
                    case 0x04 -> { // P-DATA-TF: C-FIND-RQ のコマンドと識別子。識別子（最後の DATA の PDV）を読んだら応答する
                        if (endsIdentifier(body)) {
                            out.write(findRspSuccess(acceptedPc));
                            out.flush();
                            findResponses.incrementAndGet();
                        }
                    }
                    case 0x05 -> releaseRequests.incrementAndGet(); // A-RELEASE-RQ: 黙る（応答しない）
                    case 0x07 -> { // A-ABORT: 規約どおりの相手は、接続を閉じる
                        aborts.incrementAndGet();
                        if (closeOnAbort) {
                            return;
                        }
                    }
                    default -> { // 想定外は何もしない
                    }
                }
            }
        } catch (EOFException | java.net.SocketException e) {
            // クライアントが切った（A-ABORT のあと、または強制終了）
        } catch (IOException e) {
            // 閉じるときの例外
        }
    }

    /** P-DATA-TF の中に、識別子（DATA の PDV で最後のもの）があるか。 */
    private static boolean endsIdentifier(byte[] body) {
        int i = 0;
        while (i + 6 <= body.length) {
            int len = ((body[i] & 0xff) << 24) | ((body[i + 1] & 0xff) << 16) | ((body[i + 2] & 0xff) << 8) | (body[i + 3] & 0xff);
            int control = body[i + 5] & 0xff;
            boolean command = (control & 0x01) != 0;
            boolean last = (control & 0x02) != 0;
            if (!command && last) {
                return true;
            }
            i += 4 + len;
        }
        return false;
    }

    private record Assoc(byte[] ac, int acceptedPc) {
    }

    private Assoc acAndAcceptedPc(byte[] rq) throws IOException {
        // 本体: 版(2) 予約(2) 呼ばれる AE(16) 呼ぶ AE(16) 予約(32) 項目…
        ByteArrayOutputStream pcs = new ByteArrayOutputStream();
        int accepted = -1;
        int i = 68;
        while (i + 4 <= rq.length) {
            int itemType = rq[i] & 0xff;
            int itemLen = ((rq[i + 2] & 0xff) << 8) | (rq[i + 3] & 0xff);
            if (itemType == 0x20) { // Presentation Context（RQ）: id(1) 予約(3) 抽象構文(0x30) 転送構文(0x40)…
                int id = rq[i + 4] & 0xff;
                String as = null;
                int j = i + 8;
                while (j + 4 <= i + 4 + itemLen) {
                    int subType = rq[j] & 0xff;
                    int subLen = ((rq[j + 2] & 0xff) << 8) | (rq[j + 3] & 0xff);
                    if (subType == 0x30) {
                        as = new String(rq, j + 4, subLen, StandardCharsets.US_ASCII);
                    }
                    j += 4 + subLen;
                }
                boolean ok = STUDY_ROOT_FIND.equals(as) || PATIENT_ROOT_FIND.equals(as);
                if (ok && accepted < 0) {
                    accepted = id;
                }
                byte[] ts = IMPLICIT.getBytes(StandardCharsets.US_ASCII);
                ByteArrayOutputStream pc = new ByteArrayOutputStream();
                pc.write(id);
                pc.write(0);
                pc.write(ok ? 0 : 3); // result: 0=受理、3=抽象構文の拒否
                pc.write(0);
                pc.write(0x40);
                pc.write(0);
                pc.write(ts.length >> 8);
                pc.write(ts.length & 0xff);
                pc.write(ts);
                pcs.write(0x21);
                pcs.write(0);
                pcs.write(pc.size() >> 8);
                pcs.write(pc.size() & 0xff);
                pcs.write(pc.toByteArray());
            }
            i += 4 + itemLen;
        }
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(0);
        body.write(1);
        body.write(0);
        body.write(0);
        byte[] called = pad16(aet);
        body.write(called);
        body.write(rq, 20, 16); // 呼ぶ AE をそのまま返す
        body.write(new byte[32]);
        byte[] ctx = "1.2.840.10008.3.1.1.1".getBytes(StandardCharsets.US_ASCII);
        body.write(0x10);
        body.write(0);
        body.write(ctx.length >> 8);
        body.write(ctx.length & 0xff);
        body.write(ctx);
        body.write(pcs.toByteArray());
        ByteArrayOutputStream ui = new ByteArrayOutputStream();
        ui.write(new byte[] {0x51, 0, 0, 4, 0, 0, 0x40, 0}); // 最大 PDU 長 16384
        byte[] impl = "1.2.3.4.5".getBytes(StandardCharsets.US_ASCII);
        ui.write(0x52);
        ui.write(0);
        ui.write(impl.length >> 8);
        ui.write(impl.length & 0xff);
        ui.write(impl);
        body.write(0x50);
        body.write(0);
        body.write(ui.size() >> 8);
        body.write(ui.size() & 0xff);
        body.write(ui.toByteArray());
        return new Assoc(pdu(0x02, body.toByteArray()), accepted);
    }

    private static byte[] findRspSuccess(int pcId) throws IOException {
        byte[] sop = (STUDY_ROOT_FIND + "\0").getBytes(StandardCharsets.US_ASCII); // 偶数長にする（NUL 埋め）
        ByteArrayOutputStream el = new ByteArrayOutputStream();
        el.write(element(0x0000, 0x0002, sop));
        el.write(element(0x0000, 0x0100, us(0x8020)));  // C-FIND-RSP
        el.write(element(0x0000, 0x0120, us(1)));       // 応答先のメッセージ ID
        el.write(element(0x0000, 0x0800, us(0x0101)));  // データセットなし
        el.write(element(0x0000, 0x0900, us(0x0000)));  // status 0000H（成功・該当なし）
        byte[] rest = el.toByteArray();
        byte[] cmd = concat(element(0x0000, 0x0000, ul(rest.length)), rest); // 群の長さ
        ByteArrayOutputStream pdv = new ByteArrayOutputStream();
        int pdvLen = 2 + cmd.length;
        pdv.write(new byte[] {(byte) (pdvLen >> 24), (byte) (pdvLen >> 16), (byte) (pdvLen >> 8), (byte) pdvLen});
        pdv.write(pcId);
        pdv.write(0x03); // コマンド・最後
        pdv.write(cmd);
        return pdu(0x04, pdv.toByteArray());
    }

    private static byte[] element(int group, int el, byte[] value) {
        byte[] b = new byte[8 + value.length];
        b[0] = (byte) group;
        b[1] = (byte) (group >> 8);
        b[2] = (byte) el;
        b[3] = (byte) (el >> 8);
        b[4] = (byte) value.length;
        b[5] = (byte) (value.length >> 8);
        b[6] = (byte) (value.length >> 16);
        b[7] = (byte) (value.length >> 24);
        System.arraycopy(value, 0, b, 8, value.length);
        return b;
    }

    private static byte[] us(int v) {
        return new byte[] {(byte) v, (byte) (v >> 8)};
    }

    private static byte[] ul(int v) {
        return new byte[] {(byte) v, (byte) (v >> 8), (byte) (v >> 16), (byte) (v >> 24)};
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] r = new byte[a.length + b.length];
        System.arraycopy(a, 0, r, 0, a.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }

    private static byte[] pad16(String s) {
        byte[] b = new byte[16];
        java.util.Arrays.fill(b, (byte) ' ');
        byte[] src = s.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(src, 0, b, 0, Math.min(16, src.length));
        return b;
    }

    private static byte[] pdu(int type, byte[] body) {
        byte[] b = new byte[6 + body.length];
        b[0] = (byte) type;
        b[2] = (byte) (body.length >> 24);
        b[3] = (byte) (body.length >> 16);
        b[4] = (byte) (body.length >> 8);
        b[5] = (byte) body.length;
        System.arraycopy(body, 0, b, 6, body.length);
        return b;
    }

    @Override
    public void close() {
        closed = true;
        try {
            server.close();
        } catch (IOException ignore) {
            // 閉じるだけ
        }
        synchronized (open) {
            for (Socket s : open) {
                try {
                    s.close();
                } catch (IOException ignore) {
                    // 閉じるだけ
                }
            }
        }
    }
}
