/** @type {import('next').NextConfig} */
const nextConfig = {
  // @react-pdf/renderer가 fontkit으로 assets/fonts/*.ttf를 런타임에 fs로 직접 읽는데
  // (동적 경로라 정적 분석으로 추적 안 됨), Vercel 서버리스 번들 추적이 이 파일들을
  // 자동으로 못 찾아 배포본에서 폰트가 빠지고 PDF 라우트가 500으로 죽는다.
  outputFileTracingIncludes: {
    "/**": ["./assets/fonts/**"],
  },
};

export default nextConfig;
