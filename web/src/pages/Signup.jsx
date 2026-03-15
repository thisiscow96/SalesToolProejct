import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_BASE } from '../api';
import './Signup.css';

// 이메일 형식 검사 (서버와 동일)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email.trim());
}

// 휴대폰 형식: 010 등 10~11자리 숫자 (하이픈 허용)
const PHONE_REGEX = /^01[0-9]-?[0-9]{3,4}-?[0-9]{4}$/;
function isValidPhone(phone) {
  const s = String(phone).trim().replace(/\s/g, '');
  return /^01[0-9][0-9]{7,8}$/.test(s) || PHONE_REGEX.test(s);
}

const PRIVACY_TERMS_TEXT = `제1조 (개인정보의 수집 및 이용 목적)
판매툴은 다음의 목적을 위하여 개인정보를 처리합니다.
- 회원 가입 및 관리, 서비스 제공, 민원 처리 등

제2조 (수집하는 개인정보 항목)
- 필수: 이름, 이메일, 휴대폰번호, 아이디, 비밀번호
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
  const [phone, setPhone] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [emailChecked, setEmailChecked] = useState(null);
  const [phoneChecked, setPhoneChecked] = useState(null);
  const [loginIdChecked, setLoginIdChecked] = useState(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [verifyExpiresAt, setVerifyExpiresAt] = useState(null);
  const [remainingSec, setRemainingSec] = useState(null);
  const [error, setError] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [devCode, setDevCode] = useState('');
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

  async function checkEmail() {
    if (!email.trim()) { setError('이메일을 입력하세요.'); return; }
    if (!isValidEmail(email)) { setError('이메일 형식이 올바르지 않습니다.'); setEmailChecked(false); return; }
    setChecking('email');
    setError('');
    setEmailVerified(false);
    setVerificationCode('');
    setVerifyExpiresAt(null);
    try {
      const res = await fetch(`${API_BASE}/auth/check-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      setEmailChecked(data.available === true);
      if (!data.available) setError(data.message || '이미 사용 중인 이메일입니다.');
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
    try {
      const res = await fetch(`${API_BASE}/auth/send-email-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
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
    } catch {
      setError('서버에 연결할 수 없습니다.');
    } finally {
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

  async function checkPhone() {
    if (!phone.trim()) { setError('휴대폰번호를 입력하세요.'); return; }
    if (!isValidPhone(phone)) { setError('휴대폰번호 형식이 올바르지 않습니다. (예: 010-1234-5678)'); setPhoneChecked(false); return; }
    setChecking('phone');
    setError('');
    try {
      const res = await fetch(`${API_BASE}/auth/check-phone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      setPhoneChecked(data.available === true);
      if (!data.available) setError('이미 사용 중인 휴대폰번호입니다.');
    } catch {
      setError('확인할 수 없습니다.');
      setPhoneChecked(false);
    } finally {
      setChecking('');
    }
  }

  async function checkLoginId() {
    if (!loginId.trim()) { setError('아이디를 입력하세요.'); return; }
    setChecking('login_id');
    setError('');
    try {
      const res = await fetch(`${API_BASE}/auth/check-login-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login_id: loginId.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      setLoginIdChecked(data.available === true);
      if (!data.available) setError('이미 사용 중인 아이디입니다.');
    } catch {
      setError('확인할 수 없습니다.');
      setLoginIdChecked(false);
    } finally {
      setChecking('');
    }
  }

  const canSubmit = name.trim() && email.trim() && phone.trim() && loginId.trim() && password.length >= 1
    && emailChecked === true && emailVerified && phoneChecked === true && loginIdChecked === true
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
          phone: phone.trim(),
          login_id: loginId.trim(),
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
    <div className="signup-page">
      <div className="signup-card">
        <h1 className="signup-title">회원가입</h1>
        <form className="signup-form" onSubmit={handleSubmit}>
          <label className="signup-label">
            이름
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="이름 입력"
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
                disabled={loading}
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
                    {devCode && <p className="signup-dev-code">테스트용 인증번호: <strong>{devCode}</strong> (이메일 미발송 — SMTP 미설정)</p>}
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
            휴대폰번호
            <div className="signup-input-row">
              <input
                type="tel"
                value={phone}
                onChange={(e) => { setPhone(e.target.value); setPhoneChecked(null); }}
                placeholder="예: 010-1234-5678"
                disabled={loading}
              />
              <button type="button" className="signup-check-btn" onClick={checkPhone} disabled={!!checking || loading}>
                {checking === 'phone' ? '확인 중…' : '중복확인'}
              </button>
            </div>
            {phoneChecked === true && <span className="signup-ok">사용 가능</span>}
            {phoneChecked === false && <span className="signup-dup">사용 불가</span>}
          </label>

          <label className="signup-label">
            아이디
            <div className="signup-input-row">
              <input
                type="text"
                value={loginId}
                onChange={(e) => { setLoginId(e.target.value); setLoginIdChecked(null); }}
                placeholder="아이디 입력"
                disabled={loading}
              />
              <button type="button" className="signup-check-btn" onClick={checkLoginId} disabled={!!checking || loading}>
                {checking === 'login_id' ? '확인 중…' : '중복확인'}
              </button>
            </div>
            {loginIdChecked === true && <span className="signup-ok">사용 가능</span>}
            {loginIdChecked === false && <span className="signup-dup">사용 불가</span>}
          </label>

          <label className="signup-label">
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호 입력"
              disabled={loading}
            />
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

          {error && <p className="signup-error">{error}</p>}
          <button type="submit" className="signup-btn" disabled={!canSubmit || loading}>
            {loading ? '가입 중…' : '회원가입'}
          </button>
        </form>
        <Link to="/login" className="signup-login-link">로그인</Link>
      </div>
    </div>
  );
}
