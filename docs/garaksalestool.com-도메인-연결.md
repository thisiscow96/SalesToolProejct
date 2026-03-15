# garaksalestool.com 으로 판매툴 열기

지금 **https://sales-tool-proejct.vercel.app** (로그인, 회원가입 등)에 열리는 판매툴이 **https://garaksalestool.com** 으로 열리게 하려면, 해당 **Vercel 프로젝트**에 커스텀 도메인만 연결하면 됩니다.  
백엔드(Render)는 그대로 두고, 사용자는 **garaksalestool.com** 주소로만 접속하게 할 수 있습니다.

---

## 1. Vercel에 커스텀 도메인 추가

1. **https://vercel.com** 로그인
2. 판매툴 **프론트 프로젝트** 선택 (예: sales-tool-proejct)
3. 상단 **Settings** → 왼쪽 **Domains** 클릭
4. **Add** (또는 **Add Domain**) 클릭
5. 입력란에 **`garaksalestool.com`** 입력 후 **Add**
6. (선택) **www.garaksalestool.com** 도 쓰려면 한 번 더 Add

추가하면 Vercel이 **"Configure your DNS"** 라고 하면서 **어떤 레코드를 어디에 넣으라**고 안내합니다.  
(예: `A` 레코드 → `76.76.21.21` / 또는 `CNAME` → `cname.vercel-dns.com`)

---

## 2. 도메인 산 곳에서 DNS 설정

**garaksalestool.com** 을 구매한 곳(가비아, Cloudflare, Namecheap 등)에 로그인해서 **DNS 설정**으로 갑니다.

Vercel **Domains** 화면에 나온 대로 넣으면 됩니다. 보통 아래 중 하나입니다.

| 유형 | Name(호스트) | Value |
|------|----------------|-------|
| **A** | `@` (또는 비워두기) | `76.76.21.21` |
| **CNAME** | `www` | `cname.vercel-dns.com` |

- **루트 도메인**(garaksalestool.com)만 쓸 거면 **A** 레코드 하나면 됨.
- **www.garaksalestool.com** 도 쓰려면 **www** 에 대한 **CNAME** 추가.

저장 후 **몇 분~몇 시간** 기다리면 전파됩니다. Vercel **Domains** 화면에서 상태가 **Valid Configuration** 으로 바뀌면 연결 완료입니다.

---

## 3. (선택) API도 같은 도메인으로 쓰기

지금 `vercel.json` 에서 `/api/*` 를 Render로 보내고 있으니까, **garaksalestool.com** 으로 접속해도  
`garaksalestool.com/api/...` 요청은 Vercel이 Render로 넘겨서 그대로 동작합니다.

- **VITE_API_URL** 을 **`https://garaksalestool.com`** 으로 바꾸면, 프론트가 API 호출을 모두 **garaksalestool.com** 으로 보냅니다 (같은 도메인).
- Vercel **Environment Variables** 에서 `VITE_API_URL` = `https://garaksalestool.com` 로 설정한 뒤 **Redeploy** 하면 됩니다.
- 이렇게 하면 주소창도 **garaksalestool.com** 하나로 통일됩니다.

---

## 한 줄 요약

1. **Vercel** → 프로젝트 **Settings** → **Domains** → **Add** → `garaksalestool.com` 입력  
2. **도메인 구매한 곳** DNS에 Vercel이 알려준 **A** 또는 **CNAME** 넣기  
3. 전파되면 **garaksalestool.com** 에 접속했을 때 판매툴(sales-tool-proejct)이 열림  
4. (선택) `VITE_API_URL` = `https://garaksalestool.com` 로 설정 후 Redeploy 하면 API도 같은 도메인으로 사용 가능
