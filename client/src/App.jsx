/**
 * Root application component managing session state and active view.
 */
import { useState, useEffect, useCallback } from 'react';
import { api }           from './api';
import AuthForm          from './components/AuthForm';
import WorkshopList      from './components/WorkshopList';
import WorkshopDetail    from './components/WorkshopDetail';

const TOKEN_KEY = 'seatlock_token';

export default function App() {
  const [token,              setToken]              = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user,               setUser]               = useState(null);
  const [selectedWorkshopId, setSelectedWorkshopId] = useState(null);
  const [verifying,          setVerifying]          = useState(!!localStorage.getItem(TOKEN_KEY));

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) { setVerifying(false); return; }
    api.me(stored)
      .then(data => { setUser(data.user); setVerifying(false); })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setVerifying(false);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAuth = useCallback((newToken, newUser) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    setUser(newUser);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setSelectedWorkshopId(null);
  }, []);

  if (verifying) {
    return <div className="loading-screen">Verifying session…</div>;
  }

  if (!token || !user) {
    return <AuthForm onAuth={handleAuth} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎓 SeatLock</h1>
        <div className="user-info">
          <span>Hello, <strong>{user.name}</strong></span>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <main className="app-main">
        {selectedWorkshopId ? (
          <WorkshopDetail
            workshopId={selectedWorkshopId}
            token={token}
            onBack={() => setSelectedWorkshopId(null)}
          />
        ) : (
          <WorkshopList
            token={token}
            onSelect={setSelectedWorkshopId}
          />
        )}
      </main>
    </div>
  );
}
