import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

function render() {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}

// T-203 개발용 목업(서버 없이 새 화면 확인) — 개발 서버 + VITE_DEV_MOCK=1 일 때만. 빌드에서는 이 분기가 통째로 빠진다
if (import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === '1') {
  import('./lib/devMock.js').then((m) => {
    m.installDevMock();
    render();
  });
} else {
  render();
}
