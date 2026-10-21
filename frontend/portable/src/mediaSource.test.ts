import { describe, expect, it } from "vitest";
import { mediaUrl, serverBase } from "./mediaSource";

const loc = (href: string) => new URL(href) as unknown as Location;
const TOKEN = "0123456789abcdef0123456789abcdef";

describe("serverBase（起動スクリプトのローカルサーバから開かれたか）", () => {
  it("正例: http://127.0.0.1:<port>/<トークン>/VIEWER/index.html は媒体ルートの URL を返す", () => {
    expect(serverBase(loc(`http://127.0.0.1:50123/${TOKEN}/VIEWER/index.html`))).toBe(`http://127.0.0.1:50123/${TOKEN}/`);
  });

  it("クエリ・ハッシュが付いても同じ", () => {
    expect(serverBase(loc(`http://127.0.0.1:50123/${TOKEN}/VIEWER/index.html?x=1#y`))).toBe(`http://127.0.0.1:50123/${TOKEN}/`);
  });

  it("負例: file:// は null（直接開いた場合は自動認識しない）", () => {
    expect(serverBase(loc("file:///C:/media/VIEWER/index.html"))).toBeNull();
  });

  it("負例: トークンの形でないパスは null（普通の Web 配信やトークン違反）", () => {
    expect(serverBase(loc("http://127.0.0.1:50123/VIEWER/index.html"))).toBeNull();
    expect(serverBase(loc("http://127.0.0.1:50123/abc/VIEWER/index.html"))).toBeNull();
    expect(serverBase(loc(`http://127.0.0.1:50123/${TOKEN.toUpperCase()}/VIEWER/index.html`))).toBeNull();
    expect(serverBase(loc(`http://127.0.0.1:50123/${TOKEN}/other/index.html`))).toBeNull();
  });
});

describe("mediaUrl", () => {
  const base = `http://127.0.0.1:50123/${TOKEN}/`;

  it("各セグメントをエンコードし、区切りの / は保つ（空白・日本語・# を含むパス）", () => {
    expect(mediaUrl(base, "DICOM/PID 1/2026-01-01/CT background/00000001.dcm")).toBe(
      `${base}DICOM/PID%201/2026-01-01/CT%20background/00000001.dcm`,
    );
    expect(mediaUrl(base, "DICOM/患者/a#b/1.dcm")).toBe(`${base}DICOM/${encodeURIComponent("患者")}/a%23b/1.dcm`);
  });

  it("負例: セグメントの ? や % はそのまま文字として扱われる（URL の構造を壊さない）", () => {
    const u = new URL(mediaUrl(base, "DICOM/a?b/100%.dcm"));
    expect(u.search).toBe("");
    expect(decodeURIComponent(u.pathname.split("/").slice(-2).join("/"))).toBe("a?b/100%.dcm");
  });
});
