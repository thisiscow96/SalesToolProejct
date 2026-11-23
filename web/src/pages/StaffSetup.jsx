// T-213 직원 화면 두 개
// - StaffSetup          : /staff-setup — 초대 코드로 비밀번호 정하기(로그인 전)
// - ForcePasswordChange : 임시 비밀번호로 처음 로그인한 직원이 메인 대신 보는 "새 비밀번호를 정하세요" 화면
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BusyLink } from '../components/Busy';
import { setupStaffPassword, changeMyPassword } from '../lib/staffAccess';
import './Login.css';

function Brand() {
  return (
    <aside className="auth-brand" aria-hidden="true">
      <div className="auth-brand-inner">
        <span className="auth-brand-mark" />
        <p className="auth-brand-name">판매툴</p>
        <p className="auth-brand-copy">직원 계정으로<br />장부를 함께 씁니다.</p>
      </div>
    </aside>
  );
}

function PasswordFields({ pw, setPw, pw2, setPw2, disabled }) {
  return (
    <>
      <label className="login-label">
        새 비밀번호 (8자 이상)
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" disabled={disabled} />
      </label>
      <label className="login-label">
        새 비밀번호 확인
        <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" disabled={disabled} />
      </label>
    </>
  );
}

function pwProblem(pw, pw2) {
  if ([...pw].length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (pw !== pw2) return '새 비밀번호 두 칸이 같지 않습니다.';
  return '';
}

export default function StaffSetup() {
  const navigate = useNavigate();
  const [agentNo, setAgentNo] = useState('');
  const [loginId, setLoginId] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!agentNo.trim() || !loginId.trim() || !code.trim()) return setError('중매인 번호, 직원 ID, 초대 코드를 입력하세요.');
    const p = pwProblem(pw, pw2);
    if (p) return setError(p);
    setBusy(true);
    try {
      await setupStaffPassword({ agent_no: agentNo.trim(), login_id: loginId.trim(), code: code.trim(), new_password: pw });
      navigate('/login', { replace: true, state: { message: '비밀번호를 정했습니다. 「직원으로 로그인」으로 들어가세요.', staff: true } });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page auth-page">
      <Brand />
      <div className="auth-main">
        <div className="login-card">
          <h1 className="login-title">초대 코드로 비밀번호 설정</h1>
          <p className="login-subtitle">메일로 받은 중매인 번호·직원 ID·초대 코드를 넣고 비밀번호를 정하세요.</p>
          <form className="login-form" onSubmit={submit}>
            <label className="login-label">
              중매인 번호
              <input type="text" value={agentNo} onChange={(e) => setAgentNo(e.target.value)} autoComplete="organization" disabled={busy} />
            </label>
            <label className="login-label">
              직원 ID
              <input type="text" value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" autoCapitalize="none" disabled={busy} />
            </label>
            <label className="login-label">
              초대 코드 (6자리)
              <input type="text" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" disabled={busy} />
            </label>
            <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} disabled={busy} />
            {error && <p className="login-error" role="alert">{error}</p>}
            <button type="submit" className="login-btn" disabled={busy}>{busy ? '저장 중…' : '비밀번호 정하기'}</button>
            <BusyLink busy={busy} to="/login" className="login-signup-link">로그인으로 돌아가기</BusyLink>
          </form>
        </div>
      </div>
    </div>
  );
}

export function ForcePasswordChange({ user, onDone }) {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!cur) return setError('받은 임시 비밀번호를 입력하세요.');
    const p = pwProblem(pw, pw2);
    if (p) return setError(p);
    setBusy(true);
    try {
      await changeMyPassword(cur, pw);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page auth-page">
      <Brand />
      <div className="auth-main">
        <div className="login-card">
          <h1 className="login-title">새 비밀번호를 정하세요</h1>
          <p className="login-subtitle">
            {user?.staff?.name}님, {user?.name}에서 받은 임시 비밀번호로 처음 들어왔습니다. 계속하려면 비밀번호를 바꿔 주세요.
          </p>
          <form className="login-form" onSubmit={submit}>
            <label className="login-label">
              임시 비밀번호
              <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" disabled={busy} />
            </label>
            <PasswordFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} disabled={busy} />
            {error && <p className="login-error" role="alert">{error}</p>}
            <button type="submit" className="login-btn" disabled={busy}>{busy ? '저장 중…' : '비밀번호 바꾸고 시작하기'}</button>
            <button
              type="button"
              className="login-signup-link login-link-btn"
              disabled={busy}
              onClick={() => {
                if (busy) return; // T-404: 비밀번호 저장 중에는 로그아웃하지 않는다
                window.sessionStorage.removeItem('user');
                window.location.href = '/login';
              }}
            >
              로그아웃
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
