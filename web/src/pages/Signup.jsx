import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { BusyLink } from '../components/Busy';
import { API_BASE } from '../api';
import './Signup.css';

// 이메일 형식 검사 (서버와 동일)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email.trim());
}

const PRIVACY_TERMS_TEXT = `제1조 (개인정보의 수집 및 이용 목적)
판매툴은 다음의 목적을 위하여 개인정보를 처리합니다.
- 회원 가입 및 관리, 서비스 제공, 민원 처리 등

제2조 (수집하는 개인정보 항목)
- 필수: 상호명, 이메일, 중매인 번호, 비밀번호
- 선택: 주소, 연락처 등 (서비스에 따라 추가될 수 있음)

제3조 (개인정보의 보유 및 이용 기간)
회원 탈퇴 시까지 보유하며, 관계 법령에 따라 보존할 필요가 있는 경우 해당 기간 동안 보관합니다.

제4조 (동의 거부 권리)
개인정보 수집·이용에 동의하지 않을 수 있으며, 미동의 시 회원가입이 제한됩니다.`;

const VERIFY_EXPIRE_SEC = 5 * 60;

export default function Signup() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [agentNo, setAgentNo] = useState('');
  const [password, setPassword] = useState('');
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [emailChecked, setEmailChecked] = useState(null);
  const [agentNoChecked, setAgentNoChecked] = useState(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [verifyExpiresAt, setVerifyExpiresAt] = useState(null);
  const [remainingSec, setRemainingSec] = useState(null);
  const [error, setError] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [devCode, setDevCode] = useState('');
  const [smtpError, setSmtpError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState('');
  const [sendCodeLoading, setSendCodeLoading] = useState(false);
  const [verifyCodeLoading, setVerifyCodeLoading] = useState(false);

  useEffect(() => {
    if (verifyExpiresAt == null || remainingSec <= 0) return;
    const t = setInterval(() => {
      const sec = Math.max(0, Math.ceil((verifyExpiresAt - Date.now()) / 1000));
      setRemainingSec(sec);
      if (sec <= 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [verifyExpiresAt, remainingSec]);

  // T-404: 중복확인 응답이 올 때 칸의 값이 보낸 값과 다르면 결과를 버린다(확인 중에는 칸도 잠근다)
  const emailNow = useRef(email);
  emailNow.current = email;
  const agentNoNow = useRef(agentNo);
  agentNoNow.current = agentNo;

  async function checkEmail() {
    if (!email.trim()) { setError('이메일을 입력하세요.'); return; }
    if (!isValidEmail(email)) { setError('이메일 형식이 올바르지 않습니다.'); setEmailChecked(false); return; }
    setChecking('email');
    setError('');
    setEmailVerified(false);
    setVerificationCode('');
    setVerifyExpiresAt(null);
    const sent = email.trim();
    try {
      const res = await fetch(`${API_BASE}/auth/check-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: sent }),
      });
      const data = await res.json().catch(() => ({}));
      if (emailNow.current.trim() !== sent) return; // 그 사이 칸이 바뀜 — 결과를 붙이지 않는다
      setEmailChecked(data.available === true);
      if (!res.ok) setError(data.message || '확인할 수 없습니다.');
      else if (!data.available) setError(data.message || '이미 사용 중인 이메일입니다.');
    } catch {
      setError('확인할 수 없습니다.');
      setEmailChecked(false);
    } finally {
      setChecking('');
    }
  }

  async function sendVerificationCode() {
    if (!email.trim() || !emailChecked) return;
    setSendCodeLoading(true);
    setError('');
    setVerifyError('');
    setSmtpError('');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(`${API_BASE}/auth/send-email-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || '인증번호 발송에 실패했습니다.');
        return;
      }
      setVerifyExpiresAt(Date.now() + VERIFY_EXPIRE_SEC * 1000);
      setRemainingSec(VERIFY_EXPIRE_SEC);
      setVerificationCode('');
      setDevCode(data.dev_code || '');
      setSmtpError(data.smtp_error || '');
    } catch (e) {
      if (e.name === 'AbortError') setError('요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
      else setError('서버에 연결할 수 없습니다.');
    } finally {
      clearTimeout(timeoutId);
      setSendCodeLoading(false);
    }
  }

  async function verifyCode() {
    const code = verificationCode.trim().replace(/\D/g, '');
    if (code.length !== 6) { setVerifyError('인증번호 6자리를 입력하세요.'); return; }
    setVerifyCodeLoading(true);
    setVerifyError('');
    try {
      const res = await fetch(`${API_BASE}/auth/verify-email-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setVerifyError(data.message || '인증번호가 맞지 않거나 만료되었습니다.');
        return;
      }
      setEmailVerified(true);
      setVerifyExpiresAt(null);
      setDevCode('');
    } catch {
      setVerifyError('서버에 연결할 수 없습니다.');
    } finally {
      setVerifyCodeLoading(false);
    }
  }

  async function checkAgentNo() {
    if (!agentNo.trim()) { setError('중매인 번호를 입력하세요.'); return; }
    setChecking('agent_no');
    setError('');
    const sent = agentNo.trim();
    try {
      const res = await fetch(`${API_BASE}/auth/check-agent-no`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_no: sent }),
      });
      const data = await res.json().catch(() => ({}));
      if (agentNoNow.current.trim() !== sent) return; // 그 사이 칸이 바뀜 — 결과를 붙이지 않는다
      setAgentNoChecked(data.available === true);
      if (!data.available) setError('이미 사용 중인 중매인 번호입니다.');
    } catch {
      setError('확인할 수 없습니다.');
      setAgentNoChecked(false);
    } finally {
      setChecking('');
    }
  }

  // 비밀번호 규칙은 서버와 같다 (T-114, R-04): 8자 이상, 72바이트 이하(bcrypt 상한, 한글 1자 = 3바이트)
  const pwChars = [...password].length;
  const pwBytes = new TextEncoder().encode(password).length;
  const passwordHint = !password
    ? ''
    : pwChars < 8
      ? `8자 이상 입력하세요. (지금 ${pwChars}자)`
      : pwBytes > 72
        ? '너무 깁니다. 영문·숫자 72자, 한글 24자 이내로 입력하세요.'
        : '';
  const passwordOk = password.length > 0 && !passwordHint;

  const canSubmit = name.trim() && email.trim() && agentNo.trim() && passwordOk
    && emailChecked === true && emailVerified && agentNoChecked === true
    && termsAgreed && !loading;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!termsAgreed) { setError('개인정보약관에 동의해 주세요.'); return; }
    if (!canSubmit) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          agent_no: agentNo.trim(),
          password,
          terms_agreed: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || '회원가입에 실패했습니다.');
        return;
      }
      navigate('/login', { state: { message: '회원가입이 완료되었습니다. 로그인해 주세요.' } });
    } catch {
      setError('서버에 연결할 수 없습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="signup-page auth-page">
      <aside className="auth-brand" aria-hidden="true">
        <div className="auth-brand-inner">
          <span className="auth-brand-mark" />
          <p className="auth-brand-name">판매툴</p>
          <p className="auth-brand-copy">매입부터 재고·매출·수금까지<br />하루 장부를 한 화면에서.</p>
          <ul className="auth-brand-points">
            <li>일별 매입·매출 합계와 미수 확인</li>
            <li>매입 건을 골라 바로 매출 전환</li>
            <li>거래처별 수금·환불 배분</li>
          </ul>
        </div>
      </aside>
      <div className="auth-main">
      <div className="signup-card">
        <h1 className="signup-title">회원가입</h1>
        <p className="signup-subtitle">이메일 인증 후 중매인 번호로 가입합니다.</p>
        <form className="signup-form" onSubmit={handleSubmit}>
          <label className="signup-label">
            상호명
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="상호명 입력"
              disabled={loading}
            />
          </label>

          <label className="signup-label">
            이메일
            <div className="signup-input-row">
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setEmailChecked(null); setEmailVerified(false); setVerifyExpiresAt(null); setDevCode(''); setVerifyError(''); }}
                placeholder="예: user@example.com"
                disabled={loading || checking === 'email'}
              />
              <button type="button" className="signup-check-btn" onClick={checkEmail} disabled={!!checking || loading}>
                {checking === 'email' ? '확인 중…' : '중복확인'}
              </button>
            </div>
            {emailChecked === true && <span className="signup-ok">사용 가능</span>}
            {emailChecked === false && <span className="signup-dup">사용 불가</span>}
            {emailChecked === true && (
              <div className="signup-email-verify">
                <button
                  type="button"
                  className="signup-verify-send"
                  onClick={sendVerificationCode}
                  disabled={sendCodeLoading || loading}
                >
                  {sendCodeLoading ? '발송 중…' : '인증번호 발송'}
                </button>
                {verifyExpiresAt != null && remainingSec != null && (
                  <>
                    <div className="signup-verify-row">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={verificationCode}
                        onChange={(e) => { setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setVerifyError(''); }}
                        placeholder="인증번호 6자리"
                        disabled={verifyCodeLoading || loading || remainingSec <= 0}
                      />
                      <button type="button" className="signup-check-btn" onClick={verifyCode} disabled={verifyCodeLoading || loading || remainingSec <= 0}>
                        {verifyCodeLoading ? '확인 중…' : '인증하기'}
                      </button>
                    </div>
                    {verifyError && <p className="signup-verify-error">{verifyError}</p>}
                    {devCode && <p className="signup-dev-code">테스트용 인증번호: <strong>{devCode}</strong> (이메일 미발송{smtpError ? ` — ${smtpError}` : ''})</p>}
                    <p className="signup-verify-timer">
                      {remainingSec > 0 ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, '0')} 남음` : '만료되었습니다. 인증번호를 다시 발송하세요.'}
                    </p>
                  </>
                )}
                {emailVerified && <span className="signup-ok">이메일 인증 완료</span>}
              </div>
            )}
          </label>

          <label className="signup-label">
            중매인 번호
            <div className="signup-input-row">
              <input
                type="text"
                value={agentNo}
                onChange={(e) => { setAgentNo(e.target.value); setAgentNoChecked(null); }}
                placeholder="중매인 번호 입력"
                disabled={loading || checking === 'agent_no'}
              />
              <button type="button" className="signup-check-btn" onClick={checkAgentNo} disabled={!!checking || loading}>
                {checking === 'agent_no' ? '확인 중…' : '중복확인'}
              </button>
            </div>
            {agentNoChecked === true && <span className="signup-ok">사용 가능</span>}
            {agentNoChecked === false && <span className="signup-dup">사용 불가</span>}
          </label>

          <label className="signup-label">
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
              autoComplete="new-password"
              aria-describedby="signup-password-rule"
              aria-invalid={passwordHint ? 'true' : 'false'}
              disabled={loading}
            />
            <span id="signup-password-rule" className={passwordHint ? 'signup-dup' : 'signup-ok'} role={passwordHint ? 'alert' : undefined}>
              {passwordHint || '8자 이상. 다른 사이트와 다른 비밀번호를 쓰세요.'}
            </span>
          </label>

          <div className="signup-terms">
            <button type="button" className="signup-terms-show" onClick={() => setShowTerms(!showTerms)}>
              {showTerms ? '개인정보약관 접기' : '개인정보약관 보기'}
            </button>
            {showTerms && <div className="signup-terms-text">{PRIVACY_TERMS_TEXT}</div>}
            <label className="signup-terms-check">
              <input type="checkbox" checked={termsAgreed} onChange={(e) => setTermsAgreed(e.target.checked)} disabled={loading} />
              개인정보약관에 동의합니다 (필수)
            </label>
          </div>

          {error && <p className="signup-error" role="alert">{error}</p>}
          <button type="submit" className="signup-btn" disabled={!canSubmit || loading}>
            {loading ? '가입 중…' : '회원가입'}
          </button>
        </form>
        <p className="signup-login-row">
          이미 계정이 있나요? <BusyLink busy={loading} to="/login" className="signup-login-link">로그인</BusyLink>
        </p>
      </div>
      </div>
    </div>
  );
}
