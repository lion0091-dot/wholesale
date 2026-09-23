/** @type {import('next').NextConfig} */
const nextConfig = {
  // @react-pdf/renderer가 fontkit으로 assets/fonts/*.ttf를 런타임에 fs로 직접 읽는데
  // (동적 경로라 정적 분석으로 추적 안 됨), Vercel 서버리스 번들 추적이 이 파일들을
  // 자동으로 못 찾아 배포본에서 폰트가 빠지고 PDF 라우트가 500으로 죽는다.
  // pdfkit(@react-pdf/renderer가 내부적으로 사용)도 표준 14폰트(Helvetica 등)를
  // 폰트 이름 문자열로 동적 require하기 때문에 같은 이유로 번들에서 빠진다.
  outputFileTracingIncludes: {
    "/**": ["./assets/fonts/**", "./node_modules/pdfkit/js/standard-fonts/**"],
  },

  experimental: {
    // 공급처 명세서를 현장에서 종이로 받아 폰으로 찍어 올리는 경로가 있다.
    // 요즘 폰 사진은 3~5MB가 예사라 Server Action 기본 한도(1MB)에 걸린다.
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
