import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import AuthPage from './pages/AuthPage.jsx';
import EnvelopeDetail from './pages/EnvelopeDetail.jsx';
import Settings from './pages/Settings.jsx';
import Templates from './pages/Templates.jsx';
import NotFound from './pages/NotFound.jsx';
import Join from './pages/Join.jsx';
import OAuthConsent from './pages/OAuthConsent.jsx';
import Setup from './pages/Setup.jsx';
import Admin from './pages/Admin.jsx';
import { ToastProvider } from './components/Toast.jsx';
import './styles.css';

// The PDF renderer is heavy; load it only on the pages that need it.
const Prepare = lazy(() => import('./pages/Prepare.jsx'));
const SignPage = lazy(() => import('./pages/SignPage.jsx'));

const Loading = () => <div className="empty"><p className="muted">Loading…</p></div>;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/login" element={<AuthPage />} />
            <Route path="/reset/:token" element={<AuthPage mode="reset" />} />
            <Route path="/join/:token" element={<Join />} />
            <Route path="/oauth/consent" element={<OAuthConsent />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/prepare/:id" element={<Prepare />} />
            <Route path="/envelope/:id" element={<EnvelopeDetail />} />
            <Route path="/sign/:token" element={<SignPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
