/**
 * Workshop list view displaying availability and selection controls.
 */
import { useState, useEffect } from 'react';
import { api } from '../api';

export default function WorkshopList({ onSelect }) {
  const [workshops, setWorkshops] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  useEffect(() => {
    api.listWorkshops()
      .then(data => setWorkshops(data.workshops))
      .catch(err  => setError(err.message))
      .finally(()  => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading workshops…</div>;
  if (error)   return <div className="error-banner">{error}</div>;
  if (workshops.length === 0) return <p>No workshops available.</p>;

  return (
    <div className="workshop-list">
      <h2>Available Workshops</h2>
      <div className="workshop-grid">
        {workshops.map(ws => (
          <div key={ws.id} className="workshop-card" onClick={() => onSelect(ws.id)}>
            <div className="workshop-card-header">
              <h3>{ws.name}</h3>
              <span className={`badge ${ws.isFull ? 'badge-full' : 'badge-open'}`}>
                {ws.isFull
                  ? 'Full'
                  : `${ws.availableSeats} seat${ws.availableSeats !== 1 ? 's' : ''} left`}
              </span>
            </div>
            {ws.description && <p className="workshop-desc">{ws.description}</p>}
            <div className="workshop-meta">
              <span>Capacity: {ws.capacity}</span>
              <span className="btn btn-sm btn-outline">View →</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
