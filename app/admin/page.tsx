import { redirect } from "next/navigation";

/** 홈 화면 앱의 시작 주소(/admin)가 404가 되지 않게 관리자 첫 화면으로 보낸다. */
export default function AdminHomePage() {
  redirect("/admin/suppliers");
}
