"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { seedDefaultProductsAction } from "./actions";

interface SeedDefaultProductsButtonProps {
  /** 공급사 업체 정보가 없는 데모 모드에서는 저장이 불가하므로 버튼을 잠근다. */
  disabled?: boolean;
  itemCount: number;
}

export function SeedDefaultProductsButton({
  disabled = false,
  itemCount,
}: SeedDefaultProductsButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (disabled) {
      setError("로그인 후 공급사 업체 정보가 연결되면 기본 납품 품목을 생성할 수 있습니다.");
      return;
    }

    setPending(true);
    setError(null);
    setMessage(null);

    const result = await seedDefaultProductsAction();

    setPending(false);

    if (!result.success) {
      setError(result.error ?? "기본 납품 품목 생성에 실패했습니다.");
      return;
    }

    setMessage(`기본 납품 품목 ${result.data?.created ?? 0}건을 등록했습니다.`);
    router.refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        style={{
          backgroundColor: pending ? "#94a3b8" : "#0f172a",
          color: "#ffffff",
          fontSize: "13px",
          fontWeight: 700,
          padding: "9px 14px",
          borderRadius: "8px",
          border: "none",
          cursor: pending ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {pending ? "기본 납품 품목 생성 중..." : `기본 납품 품목 ${itemCount}건 불러오기`}
      </button>

      {message && <span style={{ fontSize: "12px", color: "#166534" }}>{message}</span>}
      {error && <span style={{ fontSize: "12px", color: "#dc2626" }}>{error}</span>}
    </div>
  );
}
