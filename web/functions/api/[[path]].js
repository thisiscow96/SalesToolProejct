/**
 * Cloudflare Pages Function — /api/* 요청을 백엔드로 그대로 넘긴다 (Vercel rewrites와 같은 역할).
 * Pages 프로젝트 → Settings → Environment variables 에 API_ORIGIN 을 넣는다.
 *   예) API_ORIGIN = https://salestoolproejct.onrender.com   (끝에 / 없이)
 * 같은 도메인(/api)으로 부르므로 브라우저 CORS 설정이 필요 없다. 무료 플랜: 하루 10만 요청.
 */
export async function onRequest({ request, env }) {
  const origin = (env.API_ORIGIN || '').replace(/\/$/, '');
  if (!origin) return new Response(JSON.stringify({ ok: false, message: 'API_ORIGIN 환경 변수가 없습니다.' }), { status: 500, headers: { 'content-type': 'application/json' } });
  const url = new URL(request.url);
  const target = origin + url.pathname + url.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  const init = { method: request.method, headers, redirect: 'manual' };
  // 본문은 버퍼로 넘긴다(스트림 전달은 런타임마다 옵션이 달라 실패할 수 있음). 파일 첨부도 무료 플랜 요청 한도(100MB) 안
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
  try {
    return await fetch(target, init);
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, message: '백엔드에 연결하지 못했습니다(무료 서버가 깨어나는 중일 수 있음). 잠시 후 다시 시도하세요.' }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
