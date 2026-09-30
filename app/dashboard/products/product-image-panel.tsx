"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ChangeEvent } from "react";
import { removeProductImageAction, uploadProductImageAction } from "./actions";

interface ProductImagePanelProps {
  productId: string;
  currentImageUrl?: string | null;
}

const MAX_SIDE = 1200;

/** 폰으로 찍은 큰 사진도 올릴 수 있게 긴 변 1200px, JPEG로 줄인다. 실패하면 원본을 그대로 보낸다(서버가 4MB로 다시 거른다). */
async function shrinkImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));

    return blob ? new File([blob], "product.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

/**
 * 상품 사진 올리기 — 미니샵 상품 카드에 보인다. 상품을 먼저 저장한 뒤(수정 화면) 올린다.
 * 사진 없이도 판매에는 지장이 없다(카드가 지금처럼 글자만 표시된다).
 */
export function ProductImagePanel({ productId, currentImageUrl }: ProductImagePanelProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];

    if (!picked) return;

    setError(null);
    setNotice(null);

    startTransition(async () => {
      const file = await shrinkImage(picked);
      const formData = new FormData();
      formData.set("image", file);

      const result = await uploadProductImageAction(productId, formData);

      if (inputRef.current) inputRef.current.value = "";

      if (!result.success) {
        setError(result.error ?? "사진 업로드에 실패했습니다.");
        return;
      }

      setNotice("사진을 저장했습니다. 미니샵 상품 카드에 바로 보입니다.");
      router.refresh();
    });
  };

  const handleRemove = () => {
    if (!window.confirm("이 상품의 사진을 지울까요?")) return;

    setError(null);
    setNotice(null);

    startTransition(async () => {
      const result = await removeProductImageAction(productId);

      if (!result.success) {
        setError(result.error ?? "사진을 지우지 못했습니다.");
        return;
      }

      setNotice("사진을 지웠습니다.");
      router.refresh();
    });
  };

  return (
    <section
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "16px 20px",
        display: "flex",
        gap: "14px",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      {currentImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentImageUrl}
          alt="상품 사진"
          style={{ width: "96px", height: "96px", objectFit: "cover", borderRadius: "8px", border: "1px solid #e2e8f0" }}
        />
      ) : (
        <div
          style={{
            width: "96px",
            height: "96px",
            borderRadius: "8px",
            border: "1px dashed #cbd5e1",
            color: "#94a3b8",
            fontSize: "12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          사진 없음
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>상품 사진 (선택)</span>
        <span style={{ fontSize: "12px", color: "#64748b" }}>
          고객 미니샵의 상품 카드에 보입니다. 사진에 가격이나 연락처가 찍히지 않게 해주세요.
        </span>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleChange}
            disabled={pending}
            style={{ fontSize: "12px" }}
          />
          {currentImageUrl && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={pending}
              style={{
                padding: "4px 10px",
                fontSize: "12px",
                borderRadius: "6px",
                border: "1px solid #fecaca",
                backgroundColor: "#fff",
                color: "#b91c1c",
                cursor: pending ? "default" : "pointer",
              }}
            >
              사진 지우기
            </button>
          )}
        </div>
        {pending && <span style={{ fontSize: "12px", color: "#64748b" }}>처리 중…</span>}
        {error && <span style={{ fontSize: "12px", color: "#b91c1c" }}>{error}</span>}
        {notice && <span style={{ fontSize: "12px", color: "#166534" }}>{notice}</span>}
      </div>
    </section>
  );
}
