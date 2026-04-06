# 이슈 3 — Vercel 배포 — API 요청 405 / 500

**등록날짜:** 2026-03-15

---

- **무슨 이슈였는지 (현상)**  
  배포된 사이트에서 API 호출 시 405 Method Not Allowed 또는 500 Internal Server Error. 요청 URL이 `https://sales-tool-proejct.vercel.app/api/...`로 나감.
- **이슈 원인**  
  405: `vercel.json` rewrite가 없거나 `/api`를 백엔드가 아닌 정적 호스트로 보냄. 500: rewrite destination이 예전 백엔드(Railway 등) URL이거나, Render로 바꾼 뒤에도 `vercel.json`·`VITE_API_URL` 미갱신으로 옛 백엔드로 요청 감.
- **조치 방법**  
  `vercel.json`에서 `/api/:path*` destination을 실제 백엔드 URL로 설정(예: `https://salestoolproejct.onrender.com/api/:path*`). 백엔드 호스팅 변경 시 Vercel 환경 변수 `VITE_API_URL` 및 vercel.json rewrite를 함께 갱신 후 Redeploy.
- **교훈**  
  "백엔드만 바꾼다"고 해도 프론트/프록시가 어디로 요청을 보내는지 한 번 더 확인할 것.
