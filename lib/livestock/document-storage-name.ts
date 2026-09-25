/**
 * 명세서 원본을 Storage에 넣을 때 쓰는 파일 이름.
 *
 * Storage 객체 키는 ASCII만 받는다 — 한글이 든 경로(폰 파일함의 "거래명세서.pdf" 등)는 InvalidKey(400)로 거부돼
 * 원본이 보관되지 않고, 사진·스캔본은 원본이 유일한 내용이라 치명적이다. 그래서 키에는 고유값 + 확장자만 쓰고,
 * 사람이 보는 원래 이름은 inbound_documents.file_name 칸에 그대로 남는다.
 */
export function documentStorageName(originalName: string, uniqueId: string): string {
  const extension = originalName.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();

  return extension ? `${uniqueId}.${extension}` : uniqueId;
}
