import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Main from './pages/Main';
import Statement from './pages/Statement';
import { MonthlyReportPrint } from './pages/MonthlyReport';
import StaffSetup, { ForcePasswordChange } from './pages/StaffSetup'; // T-213

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
      // T-213 직원: staff = { id, login_id, name, role, must_change_password } | null, allow = 직원이 쓸 수 있는 쓰기 기능
      staff: data.user?.staff || null,
      allow: data.allow || null,
    };
    window.sessionStorage.setItem('user', JSON.stringify(userInfo));
    setUser(userInfo);
  };

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={handleLogin} />} />
      <Route path="/signup" element={user ? <Navigate to="/" replace /> : <Signup />} />
      <Route path="/staff-setup" element={<StaffSetup />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            {user?.staff?.must_change_password ? (
              <ForcePasswordChange user={user} onDone={() => setUser(readStoredUser())} />
            ) : (
              <Main />
            )}
          </RequireAuth>
        }
      />
      <Route path="/statement" element={<RequireAuth><Statement /></RequireAuth>} />
      <Route path="/monthly-report" element={<RequireAuth><MonthlyReportPrint /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
