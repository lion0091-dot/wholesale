import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** 로컬 검증 전용 — 운영에는 절대 배포하지 않는다. */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const email = request.nextUrl.searchParams.get("email");
  const password = request.nextUrl.searchParams.get("password");

  if (!email || !password) {
    return NextResponse.json({ error: "email/password required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  return NextResponse.redirect(new URL(request.nextUrl.searchParams.get("next") ?? "/dashboard", request.url));
}
