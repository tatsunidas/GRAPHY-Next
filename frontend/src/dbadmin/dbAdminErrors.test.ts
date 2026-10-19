import { describe, expect, it } from "vitest";
import { friendlyDbAdminError } from "./dbAdminErrors";
import { HttpError } from "../http";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";

/** キーをそのまま返す t（どのキーに写したかを検べる）。 */
const t = (key: string) => key;

describe("friendlyDbAdminError", () => {
  it("患者編集の失敗（409 patient-edit-failed）は、全部取り消されたことを伝える文言", () => {
    const e = new HttpError("patient-edit-failed: prepare sop=1.2.3 (IOException)", 409);
    expect(friendlyDbAdminError(e, t)).toBe("dbadmin.error.patientEditFailed");
    expect(ja["dbadmin.error.patientEditFailed"]).toContain("変更されていません");
    expect(en["dbadmin.error.patientEditFailed"]).toContain("no data was changed");
  });

  it("手元に無い画像を取り寄せられなかった（503）は、理由コードの文言", () => {
    expect(friendlyDbAdminError(new HttpError("offline", 503), t)).toBe("storage.unavailable.offline");
    expect(friendlyDbAdminError(new HttpError("md5-mismatch", 503), t)).toBe("storage.unavailable.md5-mismatch");
    expect(friendlyDbAdminError(new HttpError("???", 503), t)).toBe("storage.unavailable.unknown");
  });

  it("それ以外（別の 409・404・普通の例外）は従来どおりの文字列（負例: 患者編集の文言に化けない）", () => {
    expect(friendlyDbAdminError(new HttpError("conflict: other", 409), t)).toBe("HttpError: conflict: other");
    expect(friendlyDbAdminError(new HttpError("not found", 404), t)).toBe("HttpError: not found");
    expect(friendlyDbAdminError(new Error("boom"), t)).toBe("Error: boom");
    expect(friendlyDbAdminError("x", t)).toBe("x");
  });
});
