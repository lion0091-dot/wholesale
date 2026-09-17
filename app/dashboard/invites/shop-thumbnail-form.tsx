"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { submitShopThumbnailAction } from "@/app/actions/supplier-auth";

interface ShopThumbnailFormProps {
  /** 현재 등록된 썸네일 URL — 없으면 미등록 */
  currentThumbnailUrl?: string | null;
}

/**
 * 미니샵 썸네일(업체 대표 사진/로고) 업로드 폼.
 *
 * 바이어의 /my-shops 목록에서 상호명 옆에 표시된다. 상품/가격과 무관한 업체 사진
 * 하나만 다루므로 가격 정보가 노출될 여지가 구조적으로 없다.
 */
export function ShopThumbnailForm({ currentThumbnailUrl }: ShopThumbnailFormProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await submitShopThumbnailAction(formData);

      if (!result.success) {
        setError(result.error ?? "썸네일 업로드에 실패했습니다.");
        return;
      }

      setSaved(true);
      formRef.current?.reset();
      router.refresh();
    });
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
        {currentThumbnailUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentThumbnailUrl}
            alt="미니샵 썸네일"
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "8px",
              objectFit: "cover",
              border: "1px solid #e2e8f0",
              flexShrink: 0,
            }}
          />
        )}
        <label
          htmlFor="shop_thumbnail"
          style={{ fontSize: "13px", fontWeight: 600, color: "#334155" }}
        >
          미니샵 썸네일 {currentThumbnailUrl ? "(등록됨 — 재업로드 시 교체)" : "(미등록)"}
        </label>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          id="shop_thumbnail"
          name="shop_thumbnail"
          type="file"
          accept="image/png,image/jpeg"
          required
          disabled={pending}
          style={{
            flex: "1 1 220px",
            fontSize: "13px",
            padding: "8px",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            backgroundColor: "#ffffff",
          }}
        />
        <button
          type="submit"
          disabled={pending}
          style={{
            padding: "10px 16px",
            fontSize: "14px",
            fontWeight: 700,
            color: "#ffffff",
            backgroundColor: pending ? "#94a3b8" : "#0f172a",
            border: "none",
            borderRadius: "8px",
            cursor: pending ? "wait" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {pending ? "업로드 중..." : "업로드"}
        </button>
      </div>

      <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "6px" }}>
        JPG, PNG · 최대 4MB · 고객에게 바로 공개됩니다(가격 등 상품 정보는 포함되지 않습니다)
      </p>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", marginTop: "8px", lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      {saved && !error && (
        <p style={{ fontSize: "12px", color: "#166534", marginTop: "8px", lineHeight: 1.6 }}>
          ✓ 업로드되었습니다.
        </p>
      )}
    </form>
  );
}
