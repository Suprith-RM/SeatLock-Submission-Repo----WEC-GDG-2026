/**
 * Authentication form component handling login and registration.
 */
import { useState } from 'react';
import { api } from '../api';

export default function AuthForm({ onAuth }) {
  const [mode, setMode]         = useState('login');
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  function switchMode(m) {
    setMode(m);
    setError('');
    setName(''); setEmail(''); setPassword('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = mode === 'login'
        ? await api.login(email, password)
        : await api.register(name, email, password);
      onAuth(data.token, data.user);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1 className="auth-title">🎓 SeatLock</h1>
        <p className="auth-subtitle">Campus Workshop Reservations</p>

        <div className="auth-tabs">
          <button className={`tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}>Login</button>
          <button className={`tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => switchMode('register')}>Register</button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === 'register' && (
            <div className="form-group">
              <label htmlFor="name">Full Name</label>
              <input id="name" type="text" value={name} required
                onChange={e => setName(e.target.value)} placeholder="John Doe" />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} required
              onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password} required
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Min. 8 characters' : 'Your password'} />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button type="submit" className="btn btn-primary full-width" disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
