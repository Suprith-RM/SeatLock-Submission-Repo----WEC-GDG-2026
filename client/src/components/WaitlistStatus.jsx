/**
 * Waitlist status component showing queue position and leave option.
 */
export default function WaitlistStatus({ position, totalWaiting, onLeave, loading }) {
  const holdMins = Math.round(
    parseInt(import.meta.env.VITE_HOLD_DURATION_SECONDS || '300', 10) / 60
  );

  return (
    <div className="panel panel-waitlist">
      <div className="panel-icon">📋</div>
      <h3>On Waitlist</h3>
      <div className="waitlist-position">
        <span className="position-number">#{position}</span>
        <span className="position-label">of {totalWaiting} in queue</span>
      </div>
      <p className="text-muted">
        You'll automatically get a hold if a seat opens up. You'll have{' '}
        {holdMins} minutes to confirm it.
      </p>
      <button className="btn btn-ghost" onClick={onLeave} disabled={loading}>
        {loading ? 'Processing…' : 'Leave Waitlist'}
      </button>
    </div>
  );
}
