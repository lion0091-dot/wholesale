import { redirect } from "next/navigation";

export default function HistoryIndexPage() {
  redirect("/dashboard/history/products");
}
