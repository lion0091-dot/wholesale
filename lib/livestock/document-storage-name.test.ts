import { describe, expect, it } from "vitest";
import { documentStorageName } from "./document-storage-name";

describe("documentStorageName — Storage 키는 ASCII만", () => {
  it("한글·공백·특수문자가 든 이름도 ASCII 키가 되고 확장자만 남는다", () => {
    for (const name of ["거래명세서 (대성축산).PDF", "명세서.CSV", "IMG 0001.JPG", "a b&c#d.pdf"]) {
      expect(documentStorageName(name, "u1")).toMatch(/^[A-Za-z0-9._-]+$/);
    }

    expect(documentStorageName("거래명세서.PDF", "u1")).toBe("u1.pdf");
    expect(documentStorageName("IMG_0001.JPG", "u1")).toBe("u1.jpg");
  });

  it("확장자가 없거나 이상하면 고유값만 쓴다", () => {
    expect(documentStorageName("명세서", "u1")).toBe("u1");
    expect(documentStorageName("명세서.한글확장자", "u1")).toBe("u1");
    expect(documentStorageName("archive.tar.gz", "u1")).toBe("u1.gz");
  });
});
