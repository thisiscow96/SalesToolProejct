# Resend 도메인 인증 — salestool.com

`salestool.com` 으로 인증 메일을 보내려면 Resend에서 도메인을 추가한 뒤, DNS에 레코드 3개를 넣으면 됩니다.

---

## 1. Resend에서 도메인 추가

1. **https://resend.com** 로그인
2. 왼쪽 메뉴 **Domains** 클릭
3. **Add Domain** 클릭
4. **Domain** 입력란에 `salestool.com` 입력 후 **Add** 클릭
5. 다음 화면에 **추가해야 할 DNS 레코드 3개**가 나옵니다.  
   - **MX** 1개  
   - **TXT (SPF)** 1개  
   - **TXT (DKIM)** 1개  
   → 여기 나오는 **Value(값)** 를 그대로 복사해 두세요 (아래 2단계에서 씀).

---

## 2. DNS에 레코드 넣기

`salestool.com` 을 관리하는 곳(가비아, Cloudflare, 카페24, AWS Route53 등)에 로그인해서 **DNS 설정** 또는 **도메인 관리 → DNS 레코드** 로 들어갑니다.

Resend에서 보여준 **이름(Name)** 과 **값(Value)** 을 그대로 사용해 아래 3개를 추가합니다.

### 2-1. MX 레코드 (받는 쪽용)

| 항목 | 넣을 값 (예시·Resend 화면 기준) |
|------|----------------------------------|
| **유형** | MX |
| **이름/호스트** | `send` (또는 Resend가 `send.salestool.com` 이라고 하면 호스트만 `send`) |
| **값/목적지** | Resend에서 복사한 MX 값 (예: `feedback-smtp.us-east-1.amazonses.com`) |
| **우선순위** | 10 (Resend에 10 이라고 나오면 10) |

- 일부 DNS는 “호스트”에 `send.salestool.com` 전체를 넣거나, `send` 만 넣거나 합니다. Resend 안내 문구를 따르면 됩니다.

### 2-2. TXT — SPF

| 항목 | 넣을 값 |
|------|----------|
| **유형** | TXT |
| **이름/호스트** | `send` |
| **값** | Resend에서 복사한 SPF (예: `v=spf1 include:amazonses.com ~all`) |

### 2-3. TXT — DKIM

| 항목 | 넣을 값 |
|------|----------|
| **유형** | TXT |
| **이름/호스트** | Resend에 나온 그대로 (예: `resend._domainkey` 또는 `resend._domainkey.send`) |
| **값** | Resend에서 복사한 긴 DKIM 값 (예: `p=MIGfMA0GCS...` 형태) |

- **이름**이 `resend._domainkey.send` 이면 호스트는 `resend._domainkey.send` 만 넣고, `send.salestool.com` 은 넣지 않습니다 (자동으로 붙는 경우가 많음).

---

## 3. 저장 후 Resend에서 인증

1. DNS에 3개 레코드 모두 저장
2. **5~10분** 정도 기다린 뒤 (전파 시간)
3. **Resend** → **Domains** → `salestool.com` 옆 **Verify** (또는 "I've added the records") 클릭
4. 상태가 **Verified** 로 바뀌면 인증 완료

---

## 4. 발신 주소 정하기

인증이 끝나면 **아래 주소 중 하나**를 발신 주소(From)로 쓰면 됩니다.

- `noreply@salestool.com`
- `인증@salestool.com` (원하는 앞부분으로)

**Render** → Web Service → **Environment** 에서:

- `RESEND_FROM` = `noreply@salestool.com` (또는 정한 주소)

로 설정 후 **Save** → **Redeploy** 하면, 이제 **아무 이메일**로도 인증 메일이 발송됩니다.

---

## 5. 한 줄 요약

1. Resend **Domains** → **Add Domain** → `salestool.com` 추가  
2. 나온 **MX, TXT(SPF), TXT(DKIM)** 3개를 **salestool.com DNS 관리하는 곳**에 그대로 추가  
3. Resend에서 **Verify** → **Verified** 되면  
4. Render `RESEND_FROM` = `noreply@salestool.com` 으로 바꾸고 Redeploy

**정확한 MX/TXT 값**은 Resend **Domains** 화면에만 나오므로, 반드시 그곳에서 복사해서 DNS에 넣으면 됩니다.
