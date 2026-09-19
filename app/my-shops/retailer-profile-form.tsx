"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { updateRetailerProfileAction } from "@/app/actions/buyer-auth";
import { formatBusinessNumber } from "@/lib/validation/business-number";

interface RetailerProfileFormProps {
  restaurantName: string;
  representativeName: string;
  businessNumber: string | null;
  deliveryAddress: string;
  deliveryAddressDetail: string | null;
  contactPhone: string | null;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: 600,
  color: "#334155",
  marginBottom: "6px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: "15px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
  boxSizing: "border-box",
};

/**
 * 거래처(고객) 본인 정보 수정 폼.
 *
 * 상호명/배송지는 최초 주문 때 딱 한 번만 채워지고 그 뒤로는 고칠 방법이 없었다.
 * 거래명세서/계산서(면세)가 매번 이 값을 실시간으로 읽어서 만들어지므로, 여기서
 * 고치면 과거 발행분도 다시 열람할 때 자동으로 최신 정보로 나온다.
 */
export function RetailerProfileForm({
  restaurantName,
  representativeName,
  businessNumber,
  deliveryAddress,
  deliveryAddressDetail,
  contactPhone,
}: RetailerProfileFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  // 사업자등록번호가 비어있으면 접힌 버튼 뒤에 숨기지 않고 처음부터 펼쳐서 보여준다
  // (계산서(면세)·거래명세서 발행에 필요한데 놓치기 쉬운 값이라 눈에 띄게 함).
  const [open, setOpen] = useState(!businessNumber);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await updateRetailerProfileAction({
        restaurantName: String(formData.get("restaurant_name") ?? ""),
        representativeName: String(formData.get("representative_name") ?? ""),
        businessNumber: String(formData.get("business_number") ?? ""),
        deliveryAddress: String(formData.get("delivery_address") ?? ""),
        deliveryAddressDetail: String(formData.get("delivery_address_detail") ?? ""),
        contactPhone: String(formData.get("contact_phone") ?? ""),
      });

      if (!result.success) {
        setError(result.error ?? "정보 저장에 실패했습니다.");
        return;
      }

      setSaved(true);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          width: "100%",
          padding: "12px",
          fontSize: "13px",
          fontWeight: 700,
          color: "#334155",
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          cursor: "pointer",
        }}
      >
        내 정보 수정 (상호명·사업자번호·배송지·연락처)
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>내 정보 수정</div>
      <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.6, margin: 0 }}>
        여기서 고친 정보는 앞으로 발행되는 거래명세서·계산서(면세)에 그대로 반영됩니다. 이미
        발생한 발주의 문서를 다시 열람할 때도 최신 정보로 나옵니다.
      </p>

      <div>
        <label style={labelStyle} htmlFor="restaurant_name">
          상호(사업장)명 *
        </label>
        <input
          id="restaurant_name"
          name="restaurant_name"
          type="text"
          required
          minLength={2}
          maxLength={40}
          defaultValue={restaurantName}
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="representative_name">
          대표자명 *
        </label>
        <input
          id="representative_name"
          name="representative_name"
          type="text"
          required
          minLength={2}
          maxLength={30}
          defaultValue={representativeName}
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div
        style={{
          backgroundColor: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: "10px",
          padding: "12px",
        }}
      >
        <label
          style={{ ...labelStyle, color: businessNumber ? "#334155" : "#b45309" }}
          htmlFor="business_number"
        >
          사업자등록번호{" "}
          {businessNumber ? "(등록 완료 — 수정 가능)" : "⚠️ 계산서(면세)·거래명세서 발행에 꼭 필요해요"}
        </label>
        <input
          id="business_number"
          name="business_number"
          type="text"
          inputMode="numeric"
          maxLength={12}
          defaultValue={formatBusinessNumber(businessNumber)}
          placeholder="1234567890 (숫자 10자리)"
          disabled={pending}
          style={inputStyle}
        />
        <p style={{ fontSize: "11px", color: "#92400e", marginTop: "6px", lineHeight: 1.6 }}>
          공급사가 이 번호로 계산서(면세)를 작성합니다. 미등록 상태면 계산서·거래명세서에
          사업자등록번호가 빈 채로 나갑니다. 사업자가 아니면 비워두세요.
        </p>
      </div>

      <div>
        <label style={labelStyle} htmlFor="delivery_address">
          배송지 주소 *
        </label>
        <input
          id="delivery_address"
          name="delivery_address"
          type="text"
          required
          minLength={5}
          maxLength={200}
          defaultValue={deliveryAddress}
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="delivery_address_detail">
          상세주소 (선택)
        </label>
        <input
          id="delivery_address_detail"
          name="delivery_address_detail"
          type="text"
          maxLength={100}
          defaultValue={deliveryAddressDetail ?? ""}
          placeholder="예: 1층 주방 뒷문"
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="contact_phone">
          연락처 *
        </label>
        <input
          id="contact_phone"
          name="contact_phone"
          type="tel"
          required
          defaultValue={contactPhone ?? ""}
          placeholder="010-0000-0000"
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="submit"
          disabled={pending}
          style={{
            flex: 1,
            padding: "12px",
            fontSize: "14px",
            fontWeight: 700,
            color: "#ffffff",
            backgroundColor: pending ? "#94a3b8" : "#0f172a",
            border: "none",
            borderRadius: "8px",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          {pending ? "저장 중..." : "저장"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(false)}
          style={{
            padding: "12px 16px",
            fontSize: "14px",
            fontWeight: 600,
            color: "#475569",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            cursor: pending ? "wait" : "pointer",
          }}
        >
          닫기
        </button>
      </div>

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", lineHeight: 1.6 }}>
          {error}
        </p>
      )}

      {saved && !error && (
        <p style={{ fontSize: "12px", color: "#166534", lineHeight: 1.6 }}>✓ 저장되었습니다.</p>
      )}
    </form>
  );
}
