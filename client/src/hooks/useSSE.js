/**
 * React hook for workshop Server-Sent Events (SSE).
 */
import { useEffect, useRef } from 'react';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export function useSSE(workshopId, token, onMessage) {
  const handlerRef = useRef(onMessage);
  useEffect(() => { handlerRef.current = onMessage; }, [onMessage]);

  useEffect(() => {
    if (!workshopId || !token) return;

    const url = `${BASE}/api/events/workshop/${workshopId}?token=${encodeURIComponent(token)}`;
    const es  = new EventSource(url);

    es.onmessage = (event) => {
      try {
        handlerRef.current(JSON.parse(event.data));
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    es.onerror = () => {
      console.warn('SSE connection error — will auto-reconnect');
    };

    return () => {
      es.close();
    };
  }, [workshopId, token]);
}
