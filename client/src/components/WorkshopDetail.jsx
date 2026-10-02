/**
 * Workshop detail view with real-time seat counts and reservation controls.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useSSE } from '../hooks/useSSE';
import ReservationStatus from './ReservationStatus';
import WaitlistStatus    from './WaitlistStatus';

export default function WorkshopDetail({ workshopId, token, onBack }) {
  const [workshop,     setWorkshop]     = useState(null);
  const [reservation,  setReservation]  = useState(null);
  const [waitlistPos,  setWaitlistPos]  = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [actionError,  setActionError]  = useState('');
  const [actionBusy,   setActionBusy]   = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [wsData, resData] = await Promise.all([
        api.getWorkshop(workshopId),
        api.getMyReservation(token, workshopId),
      ]);
      setWorkshop(wsData.workshop);
      setReservation(resData.reservation);

      if (!resData.reservation) {
        api.getWaitlistPosition(token, workshopId)
          .then(d  => setWaitlistPos(d))
          .catch(() => setWaitlistPos(null));
      } else {
        setWaitlistPos(null);
      }
    } catch (err) {
      console.error('WorkshopDetail refresh failed:', err.message);
    } finally {
      setLoading(false);
    }
  }, [workshopId, token]);

  useEffect(() => { refresh(); }, [refresh]);

  useSSE(workshopId, token, (event) => {
    if (event.type === 'workshop_update' || event.type === 'connected') {
      setWorkshop(event.workshop);
      refresh();
    }
  });

  async function handleAction(fn) {
    setActionError('');
    setActionBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setActionError(err.message || 'Action failed. Please try again.');
    } finally {
      setActionBusy(false);
    }
  }

  // ── Renders ────────────────────────────────────────────────────────────────
  if (loading) return <div className="loading">Loading workshop…</div>;
  if (!workshop) return <div className="error-banner">Workshop not found.</div>;

  return (
    <div className="workshop-detail">
      <button className="btn btn-ghost back-btn" onClick={onBack}>← Back to list</button>

      <div className="detail-header">
        <div>
          <h2>{workshop.name}</h2>
          {workshop.description && <p className="workshop-desc">{workshop.description}</p>}
        </div>
        <span className={`badge badge-lg ${workshop.isFull ? 'badge-full' : 'badge-open'}`}>
          {workshop.isFull
            ? 'Full'
            : `${workshop.availableSeats} / ${workshop.capacity} seats`}
        </span>
      </div>

      <div className="seat-counts">
        <div className="seat-count-row">
          <span className="seat-label">Available</span>
          <span className="seat-value available">{workshop.availableSeats}</span>
        </div>
        <div className="seat-count-row">
          <span className="seat-label">Held (pending)</span>
          <span className="seat-value held">{workshop.heldCount ?? 0}</span>
        </div>
        <div className="seat-count-row">
          <span className="seat-label">Confirmed</span>
          <span className="seat-value confirmed">{workshop.confirmedCount ?? 0}</span>
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
            onConfirm={() => handleAction(() => api.confirmHold(token, reservation.id))}
            onCancel={() => handleAction(() => api.cancelReservation(token, reservation.id))}
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
            <div className="panel-icon">{workshop.isFull ? '😕' : '🎟️'}</div>
            <h3>
              {workshop.isFull ? 'Workshop Full' : 'Seat Available'}
            </h3>
            <p>
              {workshop.isFull
                ? 'No seats currently available. Join the waitlist to get notified automatically.'
                : 'Hold a seat to reserve your spot. You\'ll have 5 minutes to confirm.'}
            </p>
            {!workshop.isFull ? (
              <button className="btn btn-primary" onClick={() => handleAction(() => api.createHold(token, workshopId))} disabled={actionBusy}>
                {actionBusy ? 'Processing…' : '🎟️ Hold a Seat'}
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={() => handleAction(() => api.joinWaitlist(token, workshopId))} disabled={actionBusy}>
                {actionBusy ? 'Processing…' : '📋 Join Waitlist'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
