/**
 * Reservation status component displaying held countdown or confirmation state.
 */
import { useState, useEffect } from 'react';

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function ReservationStatus({ reservation, onConfirm, onCancel, loading }) {
  const [secondsLeft, setSecondsLeft] = useState(
    reservation.secondsUntilExpiry ?? 0
  );

  useEffect(() => {
    if (reservation.status !== 'HELD') return;
    setSecondsLeft(reservation.secondsUntilExpiry ?? 0);

    const interval = setInterval(() => {
      setSecondsLeft(s => Math.max(0, s - 1));
    }, 1000);

    return () => clearInterval(interval);
  }, [reservation.id, reservation.status, reservation.secondsUntilExpiry]);

  const isHeld      = reservation.status === 'HELD';
  const isConfirmed = reservation.status === 'CONFIRMED';
  const isExpired   = reservation.isExpired || (isHeld && secondsLeft === 0);

  if (isExpired) {
    return (
      <div className="panel panel-expired">
        <div className="panel-icon">⏰</div>
        <h3>Hold Expired</h3>
        <p>Your hold timed out and the seat has been released.</p>
        <p className="text-muted">Refresh the page to see current availability.</p>
      </div>
    );
  }

  return (
    <div className={`panel ${isHeld ? 'panel-held' : 'panel-confirmed'}`}>
      <div className="panel-icon">{isHeld ? '🕐' : '✅'}</div>
      <h3>{isHeld ? 'Seat Held' : 'Reservation Confirmed!'}</h3>
      <div className="reservation-id">ID: {reservation.id.slice(0, 8)}…</div>

      {isHeld && (
        <div className="countdown">
          <div className={`timer ${secondsLeft < 60 ? 'timer-urgent' : ''}`}>
            {formatTime(secondsLeft)}
          </div>
          <p className="timer-label">remaining to confirm your seat</p>
        </div>
      )}

      <div className="panel-actions">
        {isHeld && (
          <button className="btn btn-success" onClick={onConfirm} disabled={loading}>
            {loading ? 'Confirming…' : '✓ Confirm My Seat'}
          </button>
        )}
        <button
          className={`btn ${isConfirmed ? 'btn-danger' : 'btn-ghost'}`}
          onClick={onCancel}
          disabled={loading}
        >
          {loading ? 'Cancelling…' : isConfirmed ? '✕ Cancel Reservation' : 'Release Hold'}
        </button>
      </div>
    </div>
  );
}
