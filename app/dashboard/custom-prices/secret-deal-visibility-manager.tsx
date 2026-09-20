"use client";

import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  addSecretDealVisibilityAction,
  removeSecretDealVisibilityAction,
} from "@/app/actions/secret-deal-visibility";
import { SampleBadge } from "@/components/sample-badge";
import { AuditLogPanel } from "@/components/audit-log-panel";
import type { CustomerOption, ProductOption } from "./custom-price-manager";

export interface SecretDealAssignment {
  id: string;
  productId: string;
  productName: string;
  retailerId: string;
  retailerName: string;
}

interface SecretDealVisibilityManagerProps {
  customers: CustomerOption[];
  /** 시크릿 딜 상품만 (is_secret_deal === true) */
  secretDealProducts: ProductOption[];
  assignments: SecretDealAssignment[];
  /** 데모(샘플) 데이터일 때는 저장/삭제를 막는다. */
  readOnly?: boolean;
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  marginBottom: "5px",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  fontSize: "14px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

const cardStyle: CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "20px",
};

export function SecretDealVisibilityManager({
  customers,
  secretDealProducts,
  assignments,
  readOnly = false,
}: SecretDealVisibilityManagerProps) {
  const router = useRouter();
  const [productId, setProductId] = useState(secretDealProducts[0]?.id ?? "");
  const [retailerId, setRetailerId] = useState(customers[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const assignmentsByProduct = useMemo(() => {
    const map = new Map<string, SecretDealAssignment[]>();

    for (const row of assignments) {
      if (!map.has(row.productId)) {
        map.set(row.productId, []);
      }

      map.get(row.productId)!.push(row);
    }

    return map;
  }, [assignments]);

  if (secretDealProducts.length === 0) {
    return (
      <div
        style={{
          ...cardStyle,
          fontSize: "13px",
          color: "#64748b",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
          🔥 시크릿 딜 노출 대상 지정
        </div>
        <p>
          시크릿 딜로 등록된 상품이 없어 지정할 대상이 없습니다. 상품 관리에서 상품을
          &quot;🔥 시크릿 딜(단골 전용 마감 특가) 상품&quot;으로 켜면 여기서 특정
          고객(소매)에게만 노출되도록 지정할 수 있습니다.
        </p>
        <Link
          href="/dashboard/products"
          style={{ fontSize: "12px", fontWeight: 600, color: "#2563eb", width: "fit-content" }}
        >
          상품 관리로 이동 →
        </Link>
      </div>
    );
  }

  const isAlreadyAssigned = assignments.some(
    (row) => row.productId === productId && row.retailerId === retailerId
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (readOnly) {
      setMessage({
        type: "error",
        text: "샘플 데이터에는 노출 대상을 지정할 수 없습니다. 고객(소매) 초대와 시크릿 딜 상품 등록 후 이용해주세요.",
      });
      return;
    }

    if (!productId || !retailerId || isAlreadyAssigned) {
      return;
    }

    setPending(true);
    setMessage(null);

    const result = await addSecretDealVisibilityAction(retailerId, productId);

    setPending(false);

    if (!result.success) {
      setMessage({ type: "error", text: result.error ?? "노출 대상 지정에 실패했습니다." });
      return;
    }

    setMessage({ type: "success", text: "노출 대상을 지정했습니다." });
    router.refresh();
  };

  const handleRemove = async (assignment: SecretDealAssignment) => {
    if (readOnly) {
      setMessage({ type: "error", text: "샘플 데이터는 해제할 수 없습니다." });
      return;
    }

    setBusyId(assignment.id);
    setMessage(null);

    const result = await removeSecretDealVisibilityAction(assignment.id);

    setBusyId(null);

    if (!result.success) {
      setMessage({ type: "error", text: result.error ?? "해제에 실패했습니다." });
      return;
    }

    router.refresh();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <form onSubmit={handleSubmit} style={{ ...cardStyle, display: "grid", gap: "14px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
            🔥 시크릿 딜 노출 대상 지정
          </div>
          <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
            아무도 지정하지 않은 시크릿 딜 상품은 거래중인 모든 고객(소매)에게 그대로
            노출됩니다. 특정 고객에게만 보여주고 싶을 때만 아래에서 지정하세요.
          </p>
        </div>

        <div className="dash-form-grid-3">
          <div>
            <label htmlFor="secret_product_id" style={labelStyle}>
              시크릿 딜 상품 *
            </label>
            <select
              id="secret_product_id"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              required
              style={fieldStyle}
            >
              {secretDealProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  🔥 {product.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="secret_retailer_id" style={labelStyle}>
              고객(소매) *
            </label>
            <select
              id="secret_retailer_id"
              value={retailerId}
              onChange={(event) => setRetailerId(event.target.value)}
              required
              style={fieldStyle}
            >
              {customers.length === 0 && <option value="">거래 중인 고객(소매) 없음</option>}
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              type="submit"
              disabled={pending || !retailerId || !productId || isAlreadyAssigned}
              style={{
                width: "100%",
                padding: "10px 20px",
                fontSize: "14px",
                fontWeight: 700,
                borderRadius: "8px",
                border: "none",
                backgroundColor: pending || isAlreadyAssigned ? "#f87171" : "#dc2626",
                color: "#ffffff",
                cursor: pending || isAlreadyAssigned ? "not-allowed" : "pointer",
              }}
            >
              {pending ? "지정 중..." : isAlreadyAssigned ? "이미 지정됨" : "노출 대상 추가"}
            </button>
          </div>
        </div>

        {isAlreadyAssigned && !message && (
          <div
            style={{
              backgroundColor: "#ffedd5",
              border: "1px solid #fdba74",
              borderRadius: "8px",
              padding: "10px 12px",
              fontSize: "13px",
              fontWeight: 700,
              color: "#9a3412",
            }}
          >
            ⚠️ 이미 지정된 조합입니다 — 아래 "상품별 노출 현황"에서 해제할 수 있습니다.
          </div>
        )}

        {message && (
          <div
            role="alert"
            style={{
              backgroundColor: message.type === "error" ? "#fee2e2" : "#dcfce7",
              border: `1px solid ${message.type === "error" ? "#fecaca" : "#bbf7d0"}`,
              color: message.type === "error" ? "#991b1b" : "#166534",
              fontSize: "13px",
              padding: "10px 12px",
              borderRadius: "8px",
            }}
          >
            {message.text}
          </div>
        )}
      </form>

      <section
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "12px", borderBottom: "1px solid #e2e8f0", fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
          상품별 노출 현황
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {secretDealProducts.map((product) => {
            const rows = assignmentsByProduct.get(product.id) ?? [];

            return (
              <div
                key={product.id}
                style={{ padding: "12px", borderBottom: "1px solid #f1f5f9", display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                  🔥 {product.name}
                </div>

                {rows.length === 0 ? (
                  <p style={{ fontSize: "12px", color: "#94a3b8" }}>
                    지정된 고객 없음 — 거래중인 모든 고객에게 노출 중
                  </p>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                    {rows.map((row) => (
                      <span
                        key={row.id}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "#166534",
                          backgroundColor: "#dcfce7",
                          border: "1px solid #bbf7d0",
                          borderRadius: "999px",
                          padding: "4px 6px 4px 10px",
                        }}
                      >
                        {row.retailerName}
                        {readOnly && <SampleBadge />}
                        <button
                          type="button"
                          aria-label={`${row.retailerName} 노출 대상 해제`}
                          disabled={busyId === row.id}
                          onClick={() => void handleRemove(row)}
                          style={{
                            border: "none",
                            background: "none",
                            color: "#166534",
                            fontWeight: 800,
                            cursor: busyId === row.id ? "not-allowed" : "pointer",
                            padding: "0 2px",
                          }}
                        >
                          ✕
                        </button>
                        <AuditLogPanel
                          view="secret_deal_visibility"
                          rowId={row.id}
                          label="이력"
                          compact
                        />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
