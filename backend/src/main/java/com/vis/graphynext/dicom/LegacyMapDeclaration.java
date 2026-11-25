package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;

/**
 * 旧版が書いたマップ・フィルタ済みシリーズ（Secondary Capture・ImageType の 3 つ目が TEXTURE か LOG）の判定。
 * 画素は 0〜65535 なのに BitsStored=15・HighBit=15 と宣言しているので、BitsStored で値を切る読み方では
 * 32768 以上の画素が化ける。Radiomics の入力と NIfTI・npz の書き出しの両方が、同じ判定で断る。
 */
public final class LegacyMapDeclaration {
    private LegacyMapDeclaration() {
    }

    public static boolean matches(Attributes ds) {
        if (!UID.SecondaryCaptureImageStorage.equals(ds.getString(Tag.SOPClassUID))) {
            return false;
        }
        String[] it = ds.getStrings(Tag.ImageType);
        String kind = it != null && it.length >= 3 ? it[2] : null;
        return ("TEXTURE".equals(kind) || "LOG".equals(kind))
                && ds.getInt(Tag.BitsStored, 0) == 15 && ds.getInt(Tag.HighBit, 0) == 15;
    }
}
