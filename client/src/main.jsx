import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import AuthPage from './pages/AuthPage.jsx';
import Prepare from './pages/Prepare.jsx';
import SignPage from './pages/SignPage.jsx';
import EnvelopeDetail from './pages/EnvelopeDetail.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/prepare/:id" element={<Prepare />} />
        <Route path="/envelope/:id" element={<EnvelopeDetail />} />
        <Route path="/sign/:token" element={<SignPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
