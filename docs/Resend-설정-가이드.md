# Resend에서 해야 할 것 정리

인증 메일 발송을 위해 Resend에서 할 작업만 정리한 문서입니다.

---

## 1. 가입

1. **https://resend.com** 접속
2. **Sign up** (이메일 또는 GitHub 등으로 가입)

---

## 2. API 키 발급

1. 로그인 후 왼쪽 메뉴 **API Keys** (또는 **Integrate** → **API Keys**) 클릭
2. **Create API Key** 클릭
3. Name 예: `sales-tool-production`
4. Permission: **Sending access** (발송만 필요하면 이걸로)
5. **Add** 후 나오는 키(**re_xxxx...**)를 **한 번만 표시**되므로 **복사**해서 안전한 곳에 저장

---

## 3. 발신 주소 (From) 정하기

| 용도 | 발신 주소(From) | Resend에서 할 일 |
|------|------------------|------------------|
| **테스트** | `onboarding@resend.dev` | 별도 설정 없음. **가입한 이메일로만** 발송 가능. |
| **실서비스** (아무 메일로 발송) | `noreply@yourdomain.com` 등 | **Domains**에서 도메인 추가 후 인증(DNS 레코드 설정) 필요. |

- 처음에는 **테스트**로 `onboarding@resend.dev` 사용 → 가입한 이메일로 인증번호 보내보기.
- 나중에 본인 도메인 인증 후 `RESEND_FROM` 만 바꾸면 됨.

---

## 4. Render에 넣을 곳 (어디에 작성하는지)

**Render 대시보드**에서 아래 순서대로 넣습니다.

1. **https://dashboard.render.com** 로그인
2. 왼쪽에서 **Web Service** 하나 선택 (예: `salestoolproejct`)
3. 상단 탭에서 **Environment** 클릭
4. **Add Environment Variable** (또는 **Add from** 등) 클릭
5. 아래 두 개를 **한 줄씩** 추가:

   | Key (변수명) | Value (값) |
   |--------------|------------|
   | `RESEND_API_KEY` | Resend API Keys에서 복사한 키 (예: `re_xxxx...`) |
   | `RESEND_FROM` | 테스트: `onboarding@resend.dev` / 실서비스: 아래 5번처럼 도메인 인증 후 `noreply@도메인` |

6. **Save Changes** 클릭
7. (변수 추가/수정 후) **Manual Deploy** 또는 **Deployments** 탭에서 **Redeploy** 한 번 실행

이렇게 하면 백엔드가 재시작될 때 위 변수를 읽어서 Resend로 발송합니다.

---

## 5. 다른 이메일로도 보내려면 (도메인 인증)

- **salestool.com** 기준 단계별 가이드: [Resend-도메인인증-salestool.md](./Resend-도메인인증-salestool.md)

`onboarding@resend.dev` 는 **Resend 가입 시 쓴 이메일로만** 받을 수 있습니다.  
**회원이 입력한 아무 이메일**로 인증번호를 보내려면 **본인 도메인**을 Resend에 등록·인증해야 합니다.

### 5-1. Resend에서 도메인 추가

1. **https://resend.com** 로그인
2. 왼쪽 메뉴 **Domains** 클릭
3. **Add Domain** 클릭
4. 보낼 때 쓸 **도메인** 입력 (예: `yourdomain.com` 또는 서브도메인 `mail.yourdomain.com`)
5. **Add** 후 Resend가 안내하는 **DNS 레코드** 3가지를 확인 (아래 참고)

### 5-2. DNS 레코드 설정 (도메인 관리하는 곳에서)

도메인을 관리하는 곳(가비아, Cloudflare, AWS Route53, 카페24 등)에 들어가서 **DNS 설정**에 아래처럼 추가합니다.  
(Resend 화면에 나오는 **실제 값**을 그대로 쓰면 됩니다.)

| 유형 | Name (호스트) | Value (값) | 비고 |
|------|----------------|------------|------|
| **MX** | `send` (또는 Resend가 안내한 이름) | Resend에서 복사한 MX 값 (예: `feedback-smtp.us-east-1.amazonses.com`) | 우선순위 10 |
| **TXT** (SPF) | `send` | Resend에서 복사한 SPF 값 (예: `v=spf1 include:amazonses.com ~all`) | |
| **TXT** (DKIM) | `resend._domainkey` | Resend에서 복사한 DKIM 공개키 값 | |

- Name에 도메인까지 넣으라고 하면 `send.yourdomain.com` 처럼, **도메인만 넣으라고 하면** `send` 만 넣습니다. (Resend 안내 문구 따르기.)
- 저장 후 **전파**에 10분~최대 48시간 걸릴 수 있음.

### 5-3. Resend에서 인증 확인

1. Resend **Domains** 화면에서 해당 도메인 옆 **Verify** 클릭
2. 인증 완료되면 상태가 **Verified** 로 바뀜

### 5-4. Render에 발신 주소만 바꾸기

- Render **Environment** 에서 `RESEND_FROM` 값을 **인증한 도메인 기준 주소**로 변경  
  - 예: `noreply@yourdomain.com` 또는 `noreply@mail.yourdomain.com`
- **Save** 후 **Redeploy** 한 번

이후에는 회원이 입력한 **아무 이메일**로도 인증번호가 발송됩니다.

---

## 6. 확인 순서 요약

1. Resend 가입  
2. API Keys에서 키 생성 후 복사  
3. **Render** → Web Service → **Environment** → `RESEND_API_KEY`, `RESEND_FROM` 추가 (위 4번 참고)  
4. Render **Save** → **Redeploy**  
5. 테스트: Resend 가입 이메일로 회원가입 → 인증번호 발송  
6. 실서비스(다른 이메일로도 보내기): Resend **Domains** 에 도메인 추가 → DNS 설정(위 5-2) → Verify → Render `RESEND_FROM` 을 `noreply@도메인` 으로 변경 후 Redeploy
