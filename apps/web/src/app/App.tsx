import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { AuthProvider } from '../auth/AuthProvider.js';
import { PairingPage } from '../counter/PairingPage.js';
import { CounterView } from '../counter/CounterView.js';
import { SetupPage } from '../admin/SetupPage.js';
import { LoginPage } from '../admin/LoginPage.js';
import { Dashboard } from '../admin/Dashboard.js';
import { EventWizard } from '../admin/EventWizard.js';
import { DevicesManagement } from '../admin/DevicesManagement.js';
import { AnalyticsView } from '../admin/AnalyticsView.js';
import { SystemPanel } from '../admin/SystemPanel.js';
import { MetaResponse } from '@paxflux/shared';
import { RefreshCw } from 'lucide-react';

const RootRedirect: React.FC = () => {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkState() {
      try {
        const metaRes = await apiFetch<MetaResponse>('/api/v1/meta');
        setMeta(metaRes);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    checkState();
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-950 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin text-indigo-400" />
      </div>
    );
  }

  if (!meta?.isInitialized) {
    return <Navigate to="/setup" replace />;
  }

  return <Navigate to="/admin" replace />;
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/pair" element={<PairingPage />} />
        <Route path="/counter" element={<CounterView />} />
        <Route element={<AuthProvider />}>
          <Route path="/admin" element={<Dashboard />} />
          <Route path="/admin/events/new" element={<EventWizard />} />
          <Route path="/admin/events/:id/devices" element={<DevicesManagement />} />
          <Route path="/admin/events/:id/analytics" element={<AnalyticsView />} />
          <Route path="/admin/system" element={<SystemPanel />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};
