# 이슈 2 — 이메일 인증 — Gmail SMTP가 PaaS에서 안 됨 (ETIMEDOUT)

**등록날짜:** 2026-03-15

---

- **무슨 이슈였는지 (현상)**  
  회원가입 시 "인증번호 발송" 클릭 시 발송 중에서 멈추거나 테스트용 인증번호만 표시되고 실제 메일이 오지 않음. 로그/응답: ETIMEDOUT.
- **이슈 원인**  
  Railway, Render 모두 아웃바운드 SMTP(587, 465)를 막거나 제한. Gmail SMTP 연결이 PaaS 방화벽에서 차단. Render로 옮겨도 SMTP 미허용으로 동일 증상.
- **조치 방법**  
  Resend 등 HTTPS 기반 이메일 API 사용. `RESEND_API_KEY` 설정 시 Resend로 발송, 미설정 시 로컬에서만 Gmail SMTP(nodemailer) 사용.
- **교훈**  
  호스팅을 "이메일 되게 하려고" 바꿀 때는 해당 플랫폼의 아웃바운드 SMTP 허용 여부를 먼저 확인한 뒤 권장할 것.
