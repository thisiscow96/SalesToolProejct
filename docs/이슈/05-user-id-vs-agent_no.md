# 이슈 5 — 데이터 조회 — user id vs 중매인 번호(agent_no)

**등록날짜:** 2026-03-13

---

- **무슨 이슈였는지 (현상)**  
  요구사항: 중매인 번호(agent_no) 기준으로 데이터 조회. 기존에는 user id로만 조회하고 있음.
- **이슈 원인**  
  API·DB가 user_id 기반으로만 구성되어 있어 agent_no 기준 조회로 바꿀 필요 있음.
- **조치 방법**  
  백엔드: 헤더 X-Agent-No를 받아 "user" 테이블에서 agent_no로 user id 조회한 뒤 기존처럼 user_id로만 쿼리. 프론트: authHeaders()에서 X-Agent-No: user.agent_no 전송. DB 스키마는 user_id 기반 유지.
- **교훈**  
  "식별자"를 바꿀 때는 API 계약(헤더/파라미터)과 DB 조회 로직을 함께 바꾸고, 클라이언트가 보내는 값과 서버가 기대하는 값을 맞출 것.
