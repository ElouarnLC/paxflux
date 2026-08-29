import { useState, useEffect, useRef } from 'react';
import { CompactEventState, SSERealtimeMessage } from '@paxflux/shared';

export interface UseSSEOptions {
  url: string;
  enabled?: boolean;
  onState?: (state: CompactEventState) => void;
  onMessage?: (message: SSERealtimeMessage) => void;
}

export function useSSE(options: UseSSEOptions) {
  const { url, enabled = true, onState, onMessage } = options;
  const [isConnected, setIsConnected] = useState(false);
  const [lastState, setLastState] = useState<CompactEventState | null>(null);
  const [error, setError] = useState<Event | null>(null);

  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    let eventSource: EventSource | null = null;
    let isCleanedUp = false;

    function connect() {
      if (isCleanedUp) return;

      eventSource = new EventSource(url, { withCredentials: true });

      eventSource.onopen = () => {
        setIsConnected(true);
        setError(null);
      };

      eventSource.addEventListener('state', (event) => {
        try {
          const state: CompactEventState = JSON.parse(event.data);
          setLastState(state);
          onStateRef.current?.(state);
        } catch (err) {
          console.error('Failed to parse SSE state event:', err);
        }
      });

      eventSource.addEventListener('event-status', (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessageRef.current?.({ type: 'event-status', data });
        } catch (err) {
          console.error('Failed to parse SSE event-status event:', err);
        }
      });

      eventSource.addEventListener('device-status', (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessageRef.current?.({ type: 'device-status', data });
        } catch (err) {
          console.error('Failed to parse SSE device-status event:', err);
        }
      });

      eventSource.addEventListener('notice', (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessageRef.current?.({ type: 'notice', data });
        } catch (err) {
          console.error('Failed to parse SSE notice event:', err);
        }
      });

      eventSource.onerror = (err) => {
        setIsConnected(false);
        setError(err);
      };
    }

    connect();

    return () => {
      isCleanedUp = true;
      if (eventSource) {
        eventSource.close();
        setIsConnected(false);
      }
    };
  }, [url, enabled]);

  return { isConnected, lastState, error };
}
