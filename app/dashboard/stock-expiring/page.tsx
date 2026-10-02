import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { StockTabs } from "../section-tabs";

export const metadata = {
  title: "소비기한 임박 박스 | 도매업체 통합관리시스템",
};

interface ExpiringBox {
  boxId: string;
  traceNo: string;
  productName: string;
  unit: string;
  remaining: number;
  bestBefore: string | null;
  daysLeft: number | null;
  expired: boolean;
  basis: "best_before" | "slaughter_date";
}

const cardStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "8px 4px",
} as const;

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * 알림벨 "소비기한 임박·오래된 박스"를 누르면 오는 화면(마이그레이션 211).
 * 정의는 DB 함수 get_expiring_boxes 한 곳: 소비기한이 있는 박스는 D-3 이내이거나 지난 것,
 * 소비기한을 입력하지 않은 박스는 도축일이 14일 넘은 것. 급한 순(지난 것 → 임박)으로 보여준다.
 */
export default async function StockExpiringPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let boxes: ExpiringBox[] = [];

  if (scope?.wholesalerId) {
    const { data } = await (await createClient()).rpc("get_expiring_boxes");

    boxes = ((data ?? []) as Array<Record<string, unknown>>)
      .map((row) => ({
        boxId: String(row.box_id),
        traceNo: String(row.trace_no ?? ""),
        productName: String(row.product_name ?? "상품 미지정"),
        unit: String(row.unit ?? "kg"),
        remaining: Number(row.remaining_weight ?? 0),
        bestBefore: (row.best_before as string | null) ?? null,
        daysLeft: row.days_left === null || row.days_left === undefined ? null : Number(row.days_left),
        expired: row.expired === true,
        basis: (row.basis === "slaughter_date" ? "slaughter_date" : "best_before") as ExpiringBox["basis"],
      }))
      // 소비기한이 있는 박스를 급한 순(남은 날이 적은 순)으로, 소비기한 입력이 없는 박스는 그 뒤에.
      .sort((a, b) => {
        if (a.basis !== b.basis) return a.basis === "best_before" ? -1 : 1;

        return (a.daysLeft ?? 0) - (b.daysLeft ?? 0);
      });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <StockTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>소비기한 임박·오래된 박스</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0", lineHeight: 1.6 }}>
          소비기한이 3일 안으로 다가왔거나 지난 박스, 그리고 소비기한을 입력하지 않았는데 도축한 지 14일이 넘은 박스입니다.
          이런 박스부터 먼저 출고하거나 가격을 조정해 보세요. 출고 스캔은 소비기한이 지난 박스를 받지 않습니다.
        </p>
      </header>

      <section style={cardStyle}>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>상품</th>
                <th>이력번호</th>
                <th>남은 양</th>
                <th>소비기한</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {boxes.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ color: "#64748b" }}>
                    소비기한이 임박했거나 오래된 박스가 없습니다.
                  </td>
                </tr>
              )}
              {boxes.map((box) => (
                <tr key={box.boxId}>
                  <td style={{ fontWeight: 700 }}>{box.productName}</td>
                  <td>{box.traceNo}</td>
                  <td>
                    {formatQty(box.remaining)}
                    {box.unit}
                  </td>
                  <td>{box.bestBefore ?? "입력 안 됨"}</td>
                  <td>
                    {box.basis === "slaughter_date" ? (
                      <span style={{ color: "#92400e", fontWeight: 700 }}>도축 후 14일 넘음</span>
                    ) : box.expired ? (
                      <span style={{ color: "#b91c1c", fontWeight: 700 }}>
                        기한 지남{box.daysLeft !== null ? ` (${Math.abs(box.daysLeft)}일 전)` : ""}
                      </span>
                    ) : (
                      <span style={{ color: "#92400e", fontWeight: 700 }}>
                        {box.daysLeft === 0 ? "오늘까지" : `${box.daysLeft}일 남음`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
