import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { WithdrawAccountButton } from "./withdraw-account-button";
import type { RelationshipStatus, WholesalerStatus } from "@/types/database";

export const metadata = {
  title: "내 거래처 | 미트 파트너스",
};

/**
 * 바이어(구매 회원)가 연결된 도매업체 목록을 오가기 위한 화면.
 *
 * 폐쇄형 1:1 거래 원칙(app/shop/[shop_token]/shop-chrome.tsx의 ShopFooter 참고)에
 * 따라 이 화면은 **링크(상호명 + 이동 버튼)만** 보여준다. 상품/단가 등 카탈로그
 * 데이터는 절대 이 화면에 올리지 않는다 — 한 화면에서 여러 도매업체를 동시에
 * 로드해 비교 구매가 가능해지는 걸 원천적으로 막기 위함(명시적 요구사항).
 *
 * wholesaler_retailers RLS 정책(20260924000000)이 있어야 이 조회가 동작한다.
 */

const mainStyle: React.CSSProperties = {
  maxWidth: "600px",
  margin: "0 auto",
  minHeight: "100vh",
  backgroundColor: "#f8fafc",
  padding: "24px 20px",
  boxSizing: "border-box",
};

const noticeStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "24px 20px",
  textAlign: "center",
  color: "#475569",
  fontSize: "13px",
  lineHeight: 1.7,
};

interface JoinRow {
  wholesalers:
    | {
        business_name: string;
        representative_name: string;
        shop_token: string;
        status: WholesalerStatus;
        shop_thumbnail_url: string | null;
      }
    | Array<{
        business_name: string;
        representative_name: string;
        shop_token: string;
        status: WholesalerStatus;
        shop_thumbnail_url: string | null;
      }>
    | null;
}

export default async function MyShopsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main style={mainStyle}>
        <div style={noticeStyle}>
          로그인이 필요합니다. 도매업체로부터 받은 초대(알림톡) 링크로 먼저 접속해주세요.
        </div>
      </main>
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role !== "retailer") {
    return (
      <main style={mainStyle}>
        <div style={noticeStyle}>고객(소매) 계정에서만 이용할 수 있는 화면입니다.</div>
      </main>
    );
  }

  const { data: retailer } = await supabase
    .from("retailers")
    .select("id")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (!retailer) {
    return (
      <main style={mainStyle}>
        <div style={noticeStyle}>
          아직 등록된 거래처 정보가 없습니다. 도매업체가 보낸 초대 링크로 먼저 접속해주세요.
        </div>
      </main>
    );
  }

  const { data: rows } = await supabase
    .from("wholesaler_retailers")
    .select(
      "created_at, wholesalers ( business_name, representative_name, shop_token, status, shop_thumbnail_url )"
    )
    .eq("retailer_id", retailer.id as string)
    .eq("status", "active" satisfies RelationshipStatus)
    .order("created_at", { ascending: false });

  const shops = ((rows ?? []) as JoinRow[])
    .map((row) => (Array.isArray(row.wholesalers) ? row.wholesalers[0] : row.wholesalers))
    .filter((wholesaler): wholesaler is NonNullable<typeof wholesaler> => Boolean(wholesaler));

  return (
    <main style={mainStyle}>
      <header style={{ marginBottom: "20px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>내 거래처</h1>
        <p style={{ fontSize: "12px", color: "#64748b", marginTop: "6px", lineHeight: 1.6 }}>
          연결된 도매업체 목록입니다. 각 거래처는 서로 독립된 1:1 발주 공간이며, 이 화면에서는 상품이나
          단가를 비교할 수 없습니다.
        </p>
      </header>

      {shops.length === 0 ? (
        <div style={noticeStyle}>아직 연결된 거래처가 없습니다.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {shops.map((shop) => (
            <Link
              key={shop.shop_token}
              href={`/shop/${shop.shop_token}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "16px",
                textDecoration: "none",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                {shop.shop_thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={shop.shop_thumbnail_url}
                    alt=""
                    style={{
                      width: "44px",
                      height: "44px",
                      borderRadius: "8px",
                      objectFit: "cover",
                      border: "1px solid #e2e8f0",
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <div
                    aria-hidden
                    style={{
                      width: "44px",
                      height: "44px",
                      borderRadius: "8px",
                      backgroundColor: "#f1f5f9",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "18px",
                      flexShrink: 0,
                    }}
                  >
                    🏬
                  </div>
                )}
                <div>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>
                    {shop.business_name}
                  </div>
                  <p style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                    대표자: {shop.representative_name}
                    {shop.status !== "active" && (
                      <span style={{ color: "#b91c1c", fontWeight: 700 }}> · 현재 이용 불가</span>
                    )}
                  </p>
                </div>
              </div>
              <span style={{ fontSize: "13px", color: "#2563eb", fontWeight: 700 }}>이동 →</span>
            </Link>
          ))}
        </div>
      )}

      <WithdrawAccountButton />
    </main>
  );
}
