import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { API_BASE } from '../api';
import { refreshMe } from '../lib/staffAccess';
import './Login.css';

export default function Login({ onLogin }) {
  const location = useLocation();
  const successMessage = location.state?.message;
  // T-213: 「직원으로 로그인」 — 중매인 번호 + 직원 ID + 비밀번호
  const [asStaff, setAsStaff] = useState(!!location.state?.staff);
  const [loginId, setLoginId] = useState('');
  const [agentNo, setAgentNo] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!agentNo.trim() || !password || (asStaff && !loginId.trim())) {
      setError(asStaff ? '중매인 번호, 직원 ID, 비밀번호를 입력하세요.' : '중매인 번호와 비밀번호를 입력하세요.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(asStaff ? { agent_no: agentNo.trim(), login_id: loginId.trim(), password } : { agent_no: agentNo.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || '로그인에 실패했습니다.');
        return;
      }
      if (data.user?.staff) {
        // 직원: 쓸 수 있는 기능 목록(allow)을 먼저 받아 함께 저장한다(버튼 숨김용)
        onLogin(data);
        try {
          await refreshMe();
        } catch {
          /* 비밀번호 변경 전이어도 /api/me 는 된다 — 실패하면 화면은 서버 403 으로 안내 */
        }
        window.location.href = '/';
        return;
      }
      onLogin(data);
    } catch (err) {
      setError('서버에 연결할 수 없습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page auth-page">
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
      <div className="login-card">
        <h1 className="login-title">로그인</h1>
        <p className="login-subtitle">{asStaff ? '중매인 번호, 직원 ID, 비밀번호를 입력하세요.' : '중매인 번호와 비밀번호를 입력하세요.'}</p>
        <div className="login-mode" role="tablist" aria-label="로그인 종류">
          <button type="button" role="tab" aria-selected={!asStaff} className={'login-mode-btn' + (!asStaff ? ' active' : '')} onClick={() => { setAsStaff(false); setError(''); }}>중매인</button>
          <button type="button" role="tab" aria-selected={asStaff} className={'login-mode-btn' + (asStaff ? ' active' : '')} onClick={() => { setAsStaff(true); setError(''); }}>직원으로 로그인</button>
        </div>
        {successMessage && <p className="login-success" role="status">{successMessage}</p>}
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label">
            중매인 번호
            <input
              type="text"
              value={agentNo}
              onChange={(e) => setAgentNo(e.target.value)}
              placeholder="중매인 번호 입력"
              autoComplete="username"
              disabled={loading}
            />
          </label>
          {asStaff && (
            <label className="login-label">
              직원 ID
              <input
                type="text"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="중매인이 정해 준 직원 ID"
                autoComplete="username"
                autoCapitalize="none"
                disabled={loading}
              />
            </label>
          )}
          <label className="login-label">
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호 입력"
              autoComplete="current-password"
              disabled={loading}
            />
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? '로그인 중…' : '로그인'}
          </button>
          {asStaff ? (
            <Link to="/staff-setup" className="login-signup-link">초대 코드로 비밀번호 설정</Link>
          ) : (
            <Link to="/signup" className="login-signup-link">회원가입</Link>
          )}
        </form>
      </div>
      </div>
    </div>
  );
}
