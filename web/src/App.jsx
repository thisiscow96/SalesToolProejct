import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Main from './pages/Main';

function RequireAuth({ children }) {
  const user = window.sessionStorage.getItem('user');
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const [user, setUser] = useState(() => {
    try {
      const s = window.sessionStorage.getItem('user');
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  });

  const handleLogin = (data) => {
    const userInfo = {
      id: data.user?.id,
      name: data.user?.name,
      agent_no: data.user?.agent_no,
      is_admin: !!data.user?.is_admin,
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
