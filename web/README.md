# web (React)

판매툴의 **PC 웹 프론트엔드** (Vite + React)입니다.

## 실행 방법

백엔드(server)가 **http://localhost:3000** 에 떠 있어야 로그인 API가 동작합니다.

```cmd
cd "C:\Users\gunme\Desktop\건우\프로젝트\3. 판매툴\web"
npm install
npm run dev
```

브라우저에서 http://localhost:5173 접속 → 로그인 화면이 나옵니다.  
`/api` 요청은 Vite 프록시로 백엔드(3000)로 전달됩니다.

**서버 + 웹 실행 순서와 회원가입 테스트 방법**은 `server/README.md`의 **「4. 실행 및 회원가입 테스트」** 섹션을 참고하세요.

## 구현된 화면

- **로그인** (`/login`): 아이디·비밀번호 입력 → `POST /api/auth/login` 호출 후 성공 시 메인(/)으로 이동, 세션은 `sessionStorage`에 저장.
- **회원가입** (`/signup`): 이름, 이메일, 휴대폰, 아이디, 비밀번호 입력 → 이메일/휴대폰/아이디 중복확인 → 개인정보약관 동의 후 가입.
- **메인** (`/`): 로그인 필요. 로그아웃 버튼만 있음 (추후 메뉴·대시보드 추가 예정).

