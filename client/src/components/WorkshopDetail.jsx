/**
 * Workshop detail view with real-time seat counts and reservation controls.
 *
 * Data flow:
 *  - Initial load: fetches workshop + reservation via HTTP
 *  - SSE workshop_update: applies event.workshop directly (complete counts from sseManager)
 *    then re-fetches only the user's reservation status
 *  - SSE connected: patches workshop state with SSE snapshot
 *  - Actions: optimistic UI update → API call → full refresh to confirm
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { useSSE } from '../hooks/useSSE';
import ReservationStatus from './ReservationStatus';
import WaitlistStatus    from './WaitlistStatus';

export default function WorkshopDetail({ workshopId, token, onBack }) {
  const [workshop,    setWorkshop]    = useState(null);
  const [reservation, setReservation] = useState(null);
  const [waitlistPos, setWaitlistPos] = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [actionError, setActionError] = useState('');
  const [actionBusy,  setActionBusy]  = useState(false);

  // Track whether a full refresh is in-flight
  const refreshingRef = useRef(false);

  // ── Fetch only the user's reservation + waitlist position ──────────────────
  const refreshReservation = useCallback(async () => {
    try {
      const resData = await api.getMyReservation(token, workshopId);
      setReservation(resData.reservation);
      if (!resData.reservation) {
        api.getWaitlistPosition(token, workshopId)
          .then(d => setWaitlistPos(d))
          .catch(() => setWaitlistPos(null));
      } else {
        setWaitlistPos(null);
      }
    } catch (err) {
      console.error('Reservation refresh failed:', err.message);
    }
  }, [workshopId, token]);

  // ── Full refresh: workshop counts + reservation ────────────────────────────
  const refresh = useCallback(async () => {
    refreshingRef.current = true;
    try {
      const [wsData, resData] = await Promise.all([
        api.getWorkshop(workshopId),
        api.getMyReservation(token, workshopId),
      ]);

      // The HTTP getWorkshop endpoint (workshopService.format) does NOT return
      // heldCount/confirmedCount. Preserve SSE-supplied counts when present.
      setWorkshop(prev => {
        const base = wsData.workshop;
        if (prev && prev.heldCount !== undefined) {
          return {
            ...prev,
            ...base,
            heldCount:      base.heldCount      ?? prev.heldCount,
            confirmedCount: base.confirmedCount  ?? prev.confirmedCount,
          };
        }
        return base;
      });

      setReservation(resData.reservation);

      if (!resData.reservation) {
        api.getWaitlistPosition(token, workshopId)
          .then(d => setWaitlistPos(d))
          .catch(() => setWaitlistPos(null));
      } else {
        setWaitlistPos(null);
      }
    } catch (err) {
      console.error('WorkshopDetail refresh failed:', err.message);
    } finally {
      setLoading(false);
      refreshingRef.current = false;
    }
  }, [workshopId, token]);

  // Initial load
  useEffect(() => { refresh(); }, [refresh]);

  // Polling fallback every 10s in case SSE events are missed
  useEffect(() => {
    const id = setInterval(() => {
      if (!refreshingRef.current) refreshReservation();
    }, 10_000);
    return () => clearInterval(id);
  }, [refreshReservation]);

  useSSE(workshopId, token, (event) => {
    if (event.type === 'workshop_update' && event.workshop) {
      // sseManager sends complete counts (heldCount, confirmedCount) — apply directly
      // for an instant UI update, then sync only the user's reservation state
      setWorkshop(prev => prev ? { ...prev, ...event.workshop } : event.workshop);
      refreshReservation();
    }
    if (event.type === 'connected' && event.workshop) {
      // On first SSE connect patch in the accurate seat counts
      setWorkshop(prev => prev ? { ...prev, ...event.workshop } : event.workshop);
    }
  });

  // ── Action handler with optimistic update support ──────────────────────────
  async function handleAction(fn, optimistic) {
    setActionError('');
    setActionBusy(true);
    if (optimistic) setWorkshop(prev => prev ? { ...prev, ...optimistic(prev) } : prev);
    try {
      await fn();
      await refresh();
    } catch (err) {
      if (optimistic) await refresh(); // roll back optimistic change
      setActionError(err.message || 'Action failed. Please try again.');
    } finally {
      setActionBusy(false);
    }
  }

  // ── Renders ────────────────────────────────────────────────────────────────
  if (loading) return <div className="loading">Loading workshop…</div>;
  if (!workshop) return <div className="error-banner">Workshop not found.</div>;

  // Compute derived counts — prioritise SSE-supplied values over HTTP-returned availableSeats
  const heldCount      = workshop.heldCount      ?? 0;
  const confirmedCount = workshop.confirmedCount  ?? 0;
  const availableSeats = workshop.heldCount !== undefined
    ? Math.max(0, workshop.capacity - heldCount - confirmedCount)
    : (workshop.availableSeats ?? 0);
  const isFull = availableSeats === 0;

  return (
    <div className="workshop-detail">
      <button className="btn btn-ghost back-btn" onClick={onBack}>← Back to list</button>

      <div className="detail-header">
        <div>
          <h2>{workshop.name}</h2>
          {workshop.description && <p className="workshop-desc">{workshop.description}</p>}
        </div>
        <span className={`badge badge-lg ${isFull ? 'badge-full' : 'badge-open'}`}>
          {isFull ? 'Full' : `${availableSeats} / ${workshop.capacity} seats`}
        </span>
      </div>

      <div className="seat-counts">
        <div className="seat-count-row">
          <span className="seat-label">Available</span>
          <span className="seat-value available">{availableSeats}</span>
        </div>
        <div className="seat-count-row">
          <span className="seat-label">Held (pending)</span>
          <span className="seat-value held">{heldCount}</span>
        </div>
        <div className="seat-count-row">
          <span className="seat-label">Confirmed</span>
          <span className="seat-value confirmed">{confirmedCount}</span>
        </div>
        <div className="seat-count-row total">
          <span className="seat-label">Total capacity</span>
          <span className="seat-value">{workshop.capacity}</span>
        </div>
      </div>
      {actionError && (
        <div className="error-banner" style={{ marginBottom: '1rem' }}>
          {actionError}
          <button className="btn-close" onClick={() => setActionError('')}>✕</button>
        </div>
      )}

      <div className="detail-body">
        {reservation ? (
          <ReservationStatus
            reservation={reservation}
            onConfirm={() => handleAction(
              () => api.confirmHold(token, reservation.id),
              prev => ({
                heldCount:      Math.max(0, (prev.heldCount ?? 0) - 1),
                confirmedCount: (prev.confirmedCount ?? 0) + 1,
              }),
            )}
            onCancel={() => handleAction(
              () => api.cancelReservation(token, reservation.id),
              prev => reservation.status === 'HELD'
                ? { heldCount: Math.max(0, (prev.heldCount ?? 0) - 1) }
                : { confirmedCount: Math.max(0, (prev.confirmedCount ?? 0) - 1) },
            )}
            onExpire={refresh}
            loading={actionBusy}
          />
        ) : waitlistPos ? (
          <WaitlistStatus
            position={waitlistPos.position}
            totalWaiting={waitlistPos.totalWaiting}
            onLeave={() => handleAction(() => api.leaveWaitlist(token, workshopId))}
            loading={actionBusy}
          />
        ) : (
          <div className="panel panel-empty">
            <div className="panel-icon">{isFull ? '😕' : '🎟️'}</div>
            <h3>{isFull ? 'Workshop Full' : 'Seat Available'}</h3>
            <p>
              {isFull
                ? 'No seats currently available. Join the waitlist to get notified automatically.'
                : "Hold a seat to reserve your spot. You'll have 5 minutes to confirm."}
            </p>
            {!isFull ? (
              <button
                className="btn btn-primary"
                onClick={() => handleAction(
                  () => api.createHold(token, workshopId),
                  prev => ({
                    heldCount:      (prev.heldCount ?? 0) + 1,
                    availableSeats: Math.max(0, availableSeats - 1),
                    isFull:         availableSeats - 1 <= 0,
                  }),
                )}
                disabled={actionBusy}
              >
                {actionBusy ? 'Processing…' : '🎟️ Hold a Seat'}
              </button>
            ) : (
              <button
                className="btn btn-secondary"
                onClick={() => handleAction(() => api.joinWaitlist(token, workshopId))}
                disabled={actionBusy}
              >
                {actionBusy ? 'Processing…' : '📋 Join Waitlist'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
