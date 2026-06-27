package com.vis.graphynext.dicom;

import org.dcm4che3.data.UID;
import org.dcm4che3.net.TransferCapability;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/**
 * 受理する Storage SOP Class（C-STORE）を設定リソースから読み、SCP 用の
 * {@link TransferCapability} 群に変換するローダ。
 *
 * <p>all-storage（"*"/"*"）を避け SOP クラスを明示列挙することで、将来の C-GET/C-MOVE
 * SCP と整合させる。キーワードは dcm4che の {@link UID#forName(String)} で UID へ解決し、
 * 未知のキーワードは警告してスキップする（起動を止めない）。
 */
public final class StorageSopClasses {

    private static final Logger log = LoggerFactory.getLogger(StorageSopClasses.class);

    private StorageSopClasses() {
    }

    /** クラスパス上の properties から SCP TransferCapability 群を構築する。 */
    public static List<TransferCapability> scpCapabilities(String classpathResource) {
        Properties p = new Properties();
        try (InputStream in = StorageSopClasses.class.getResourceAsStream(classpathResource)) {
            if (in == null) {
                throw new IllegalStateException("Storage SOP Class 設定が見つかりません: " + classpathResource);
            }
            p.load(in);
        } catch (IOException e) {
            throw new IllegalStateException("Storage SOP Class 設定の読み込みに失敗: " + classpathResource, e);
        }

        List<TransferCapability> caps = new ArrayList<>();
        for (String key : p.stringPropertyNames()) {
            String sopUid = resolveUid(key);
            if (sopUid == null) {
                log.warn("未知の SOP Class キーワードをスキップ: {}", key);
                continue;
            }
            String[] tsuids = resolveTransferSyntaxes(p.getProperty(key));
            if (tsuids.length == 0) {
                log.warn("SOP Class {} の Transfer Syntax が解決できずスキップ", key);
                continue;
            }
            caps.add(new TransferCapability(null, sopUid, TransferCapability.Role.SCP, tsuids));
        }
        log.info("Storage SOP Class を {} 件登録（{}）", caps.size(), classpathResource);
        return caps;
    }

    private static String[] resolveTransferSyntaxes(String value) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty() || v.equals("*")) {
            return new String[]{"*"};
        }
        List<String> list = new ArrayList<>();
        for (String token : v.split(",")) {
            String ts = resolveUid(token.trim());
            if (ts != null) {
                list.add(ts);
            } else {
                log.warn("未知の Transfer Syntax をスキップ: {}", token.trim());
            }
        }
        return list.toArray(String[]::new);
    }

    /** キーワード（CTImageStorage 等）または生 UID を UID 文字列へ解決。未知なら null。 */
    private static String resolveUid(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        if (token.chars().allMatch(c -> c == '.' || (c >= '0' && c <= '9'))) {
            return token; // 既に UID
        }
        try {
            return UID.forName(token);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
