/**
 * 거래명세서 발행에 필요한 정보가 빠졌을 때 보여줄 안내 페이지.
 *
 * "📄 거래명세서 PDF" 링크는 새 탭(target="_blank")으로 여는 걸 전제로 하므로,
 * 여기서 JSON 에러를 그냥 던지면 사용자에게 알아볼 수 없는 텍스트만 보인다.
 * 대신 사람이 읽을 수 있는 최소한의 HTML 페이지를 돌려준다.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface MissingFieldsPageOptions {
  missingFields: string[];
  /** 지금 이 화면에서 직접 고칠 수 있는 경우에만 제공 (예: 공급사 본인) */
  actionHref?: string;
  actionLabel?: string;
  /** 본인이 고칠 수 없는 경우(예: 바이어) 보여줄 추가 안내 */
  note?: string;
  /** 문서 명칭 — 거래명세서/계산서 등 호출부가 지정. 기본값 "거래명세서" */
  documentLabel?: string;
}

export function renderMissingFieldsHtml({
  missingFields,
  actionHref,
  actionLabel,
  note,
  documentLabel = "거래명세서",
}: MissingFieldsPageOptions): string {
  const items = missingFields.map((field) => `<li>${escapeHtml(field)}</li>`).join("");

  const actionHtml = actionHref
    ? `<a href="${escapeHtml(actionHref)}" style="display:inline-block;margin-top:16px;background:#0f172a;color:#fff;font-weight:700;font-size:14px;padding:11px 20px;border-radius:8px;text-decoration:none;">${escapeHtml(
        actionLabel ?? "지금 등록하기"
      )} →</a>`
    : "";

  const noteHtml = note
    ? `<p style="font-size:13px;color:#64748b;line-height:1.7;margin-top:12px;">${escapeHtml(note)}</p>`
    : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(documentLabel)} 발행 불가</title>
</head>
<body style="margin:0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#0f172a;">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #fee2e2;border-radius:12px;padding:28px;">
<div style="font-size:32px;margin-bottom:10px;">⚠️</div>
<h1 style="font-size:17px;font-weight:800;margin:0 0 8px;">${escapeHtml(documentLabel)}를 발행할 수 없습니다</h1>
<p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 10px;">
다음 정보가 등록되지 않아 ${escapeHtml(documentLabel)} PDF를 만들 수 없습니다. 빈 값을 '-'로 채워 발행하지 않고,
정보가 채워질 때까지 발행을 막고 있습니다.
</p>
<ul style="font-size:13px;color:#b91c1c;font-weight:700;line-height:1.9;margin:0 0 4px;padding-left:20px;">
${items}
</ul>
${noteHtml}
${actionHtml}
</div>
</body>
</html>`;
}
