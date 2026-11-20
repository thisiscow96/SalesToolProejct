import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Main from './pages/Main';
import Statement from './pages/Statement';

// 저장된 로그인 정보 — 토큰(T-101)이 없는 예전 형식은 로그아웃 상태로 본다
function readStoredUser() {
  try {
    const s = window.sessionStorage.getItem('user');
    const u = s ? JSON.parse(s) : null;
    return u && u.token ? u : null;
  } catch {
    return null;
  }
}

function RequireAuth({ children }) {
  if (!readStoredUser()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const [user, setUser] = useState(readStoredUser);

  const handleLogin = (data) => {
    const userInfo = {
      id: data.user?.id,
      name: data.user?.name,
      agent_no: data.user?.agent_no,
      is_admin: !!data.user?.is_admin,
      token: data.token,
    };
    window.sessionStorage.setItem('user', JSON.stringify(userInfo));
    setUser(userInfo);
  };

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={handleLogin} />} />
      <Route path="/signup" element={user ? <Navigate to="/" replace /> : <Signup />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Main />
          </RequireAuth>
        }
      />
      <Route path="/statement" element={<RequireAuth><Statement /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
