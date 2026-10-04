/**
 * Workshop list view displaying availability and selection controls.
 *
 * NOTE: The listWorkshops HTTP endpoint always returns availableSeats = capacity
 * due to a field-name mismatch in workshopService.format() (reads available_seats
 * but the repo returns availableSeats). Each WorkshopCard subscribes to its SSE
 * stream so the connected event immediately patches in the correct counts.
 */
import { useState, useEffect } from 'react';
import { api } from '../api';
import { useSSE } from '../hooks/useSSE';

export default function WorkshopList({ token, onSelect, refreshKey }) {
  const [workshops, setWorkshops] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    api.listWorkshops()
      .then(data => setWorkshops(data.workshops))
      .catch(err  => setError(err.message))
      .finally(()  => setLoading(false));
  }, [refreshKey]);

  if (loading) return <div className="loading">Loading workshops...</div>;
  if (error)   return <div className="error-banner">{error}</div>;
  if (workshops.length === 0) return <p>No workshops available.</p>;

  return (
    <div className="workshop-list">
      <h2>Available Workshops</h2>
      <div className="workshop-grid">
        {workshops.map(ws => (
          <WorkshopCard key={ws.id} ws={ws} token={token} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

/**
 * Individual workshop card with its own SSE subscription.
 * The HTTP list endpoint returns wrong availableSeats; SSE connected event fixes it.
 */
function WorkshopCard({ ws: initial, token, onSelect }) {
  const [ws, setWs] = useState(initial);

  useSSE(ws.id, token, (event) => {
    if ((event.type === 'connected' || event.type === 'workshop_update') && event.workshop) {
      setWs(prev => ({ ...prev, ...event.workshop }));
    }
  });

  const heldCount      = ws.heldCount      ?? 0;
  const confirmedCount = ws.confirmedCount  ?? 0;
  const availableSeats = ws.heldCount !== undefined
    ? Math.max(0, ws.capacity - heldCount - confirmedCount)
    : (ws.availableSeats ?? ws.capacity);
  const isFull = availableSeats === 0;
  const seats  = availableSeats;

  return (
    <div className="workshop-card" onClick={() => onSelect(ws.id)}>
      <div className="workshop-card-header">
        <h3>{ws.name}</h3>
        <span className={'badge ' + (isFull ? 'badge-full' : 'badge-open')}>
          {isFull ? 'Full' : (seats + ' seat' + (seats !== 1 ? 's' : '') + ' left')}
        </span>
      </div>
      {ws.description && <p className="workshop-desc">{ws.description}</p>}
      <div className="workshop-meta">
        <span>Capacity: {ws.capacity}</span>
        <span className="btn btn-sm btn-outline">View</span>
      </div>
    </div>
  );
}