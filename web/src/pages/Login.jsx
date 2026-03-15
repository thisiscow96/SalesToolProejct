import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { API_BASE } from '../api';
import './Login.css';

export default function Login({ onLogin }) {
  const location = useLocation();
  const successMessage = location.state?.message;
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!loginId.trim() || !password) {
      setError('아이디와 비밀번호를 입력하세요.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login_id: loginId.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || '로그인에 실패했습니다.');
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
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">판매툴</h1>
        {successMessage && <p className="login-success">{successMessage}</p>}
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label">
            아이디
            <input
              type="text"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="아이디 입력"
              autoComplete="username"
              disabled={loading}
            />
          </label>
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
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? '로그인 중…' : '로그인'}
          </button>
          <Link to="/signup" className="login-signup-link">회원가입</Link>
        </form>
      </div>
    </div>
  );
}
