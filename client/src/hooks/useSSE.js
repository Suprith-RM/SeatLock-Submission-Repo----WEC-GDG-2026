/**
 * React hook for workshop Server-Sent Events (SSE).
 * Uses @microsoft/fetch-event-source to allow Authorization: Bearer <token> headers.
 */
import { useEffect, useRef } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export function useSSE(workshopId, token, onMessage) {
  const handlerRef = useRef(onMessage);
  useEffect(() => { handlerRef.current = onMessage; });

  useEffect(() => {
    if (!workshopId || !token) return;

    const controller = new AbortController();

    fetchEventSource(`${BASE}/api/events/workshop/${workshopId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,

      onopen: async (response) => {
        if (!response.ok) {
          throw new Error(`SSE open failed: ${response.status}`);
        }
      },

      onmessage: (event) => {
        if (!event.data) return;
        try {
          const data = JSON.parse(event.data);
          handlerRef.current(data);
        } catch (err) {
          console.warn('[SSE] Failed to parse event:', event.data, err);
        }
      },

      onerror: (err) => {
        if (err.name === 'AbortError') {
          throw err;
        }
        console.warn('[SSE] Connection error, retrying:', err.message);
      },
    }).catch((err) => {
      if (err.name !== 'AbortError') {
        console.error('[SSE] Fatal error, stopped:', err.message);
      }
    });

    return () => {
      controller.abort();
    };
  }, [workshopId, token]);
}
