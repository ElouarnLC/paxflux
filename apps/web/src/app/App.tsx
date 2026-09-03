import React, { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { AuthProvider } from '../auth/AuthProvider.js';
import { PairingPage } from '../counter/PairingPage.js';
import { CounterView } from '../counter/CounterView.js';
import { SetupPage } from '../admin/SetupPage.js';
import { LoginPage } from '../admin/LoginPage.js';
import { Dashboard } from '../admin/Dashboard.js';
import { EventWizard } from '../admin/EventWizard.js';
import { DraftEditor } from '../admin/DraftEditor.js';
import { DevicesManagement } from '../admin/DevicesManagement.js';
import { AnalyticsView } from '../admin/AnalyticsView.js';
import { SystemPanel } from '../admin/SystemPanel.js';
import { MetaResponse } from '@paxflux/shared';
import { RefreshCw, WifiOff } from 'lucide-react';
import { readLocalDeviceIdentity } from '../offline/snapshot.js';
import { MetaOutcome, RootDestination, destinationPath, resolveRootDestination } from './root-route.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CenteredPanel } from '@/components/paxflux/layout';

/**
 * The application root, which is also every installed phone's launch URL.
 *
 * Local device identity is read first and decides alone; the server is asked
 * only when this browser has never been paired. See `root-route.ts` for why
 * that ordering is the fix rather than an optimisation.
 */
const RootRedirect: React.FC = () => {
  const [destination, setDestination] = useState<RootDestination | null>(null);

  /**
   * Resolves once. Called on mount and again by the retry button, rather
   * than re-run through a counter in the dependency list — the retry is a
   * deliberate action, and saying so keeps it out of React's hands.
   */
  const resolve = useCallback(async () => {
    setDestination(null);

    const identity = await readLocalDeviceIdentity();

    // A paired phone stops here. No request is made, so an installed
    // counter opened with no network still reaches its counter.
    if (identity && (identity.hasBootstrap || identity.hasPendingSession)) {
      setDestination(resolveRootDestination(identity, { kind: 'unreachable' }));
      return;
    }

    let meta: MetaOutcome;
    try {
      const res = await apiFetch<MetaResponse>('/api/v1/meta');
      meta = res.isInitialized ? { kind: 'initialized' } : { kind: 'uninitialized' };
    } catch {
      // Not an answer, and not treated as one. The old code left `meta`
      // null here and fell through to `/setup`, offering to create a first
      // administrator on an instance that already had one.
      meta = { kind: 'unreachable' };
    }

    setDestination(resolveRootDestination(identity, meta));
  }, []);

  useEffect(() => {
    resolve();
  }, [resolve]);

  if (destination === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <RefreshCw className="size-8 animate-spin text-primary-accent" />
      </div>
    );
  }

  const path = destinationPath(destination);
  if (path !== null) return <Navigate to={path} replace />;

  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <CenteredPanel
        icon={WifiOff}
        title="Serveur injoignable"
        description="PaxFlux n’a pas pu contacter le serveur."
        className="text-center"
      >
        <Alert tone="danger" className="my-4 text-left" data-testid="root-server-unavailable">
          <WifiOff />
          <div className="min-w-0">
            <AlertTitle>Impossible de joindre le serveur</AlertTitle>
            <AlertDescription>
              Cet appareil n’est appairé à aucune porte, et le serveur ne répond pas. Vérifiez la connexion réseau,
              puis réessayez.
            </AlertDescription>
          </div>
        </Alert>
        <Button onClick={resolve} className="w-full sm:w-auto">
          <RefreshCw />
          Réessayer
        </Button>
      </CenteredPanel>
    </div>
  );
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
          <Route path="/admin/events/:id/edit" element={<DraftEditor />} />
          <Route path="/admin/events/:id/devices" element={<DevicesManagement />} />
          <Route path="/admin/events/:id/analytics" element={<AnalyticsView />} />
          <Route path="/admin/system" element={<SystemPanel />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};
