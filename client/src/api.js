/**
 * API client module for HTTP requests.
 */
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function apiFetch(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);

  // SSE endpoint — don't parse as JSON
  if (options._sse) return response;

  const data = await response.json();
  if (!response.ok) {
    const err  = new Error(data.error?.message || 'Request failed.');
    err.code   = data.error?.code;
    err.status = response.status;
    throw err;
  }
  return data;
}

function headers(token) {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export const api = {
  // Auth
  login: (email, password) =>
    apiFetch('/api/auth/login', {
      method: 'POST',
      headers: headers(null),
      body: JSON.stringify({ email, password }),
    }),

  register: (name, email, password) =>
    apiFetch('/api/auth/register', {
      method: 'POST',
      headers: headers(null),
      body: JSON.stringify({ name, email, password }),
    }),

  me: (token) => apiFetch('/api/auth/me', { headers: headers(token) }),

  // Workshops
  listWorkshops: ()   => apiFetch('/api/workshops'),
  getWorkshop:   (id) => apiFetch(`/api/workshops/${id}`),

  // Reservations
  getMyReservation: (token, workshopId) =>
    apiFetch(`/api/workshops/${workshopId}/my-reservation`, { headers: headers(token) }),

  createHold: (token, workshopId) =>
    apiFetch(`/api/workshops/${workshopId}/holds`, {
      method: 'POST',
      headers: {
        ...headers(token),
        'Idempotency-Key': crypto.randomUUID(),
      },
    }),

  confirmHold: (token, reservationId) =>
    apiFetch(`/api/reservations/${reservationId}/confirm`, {
      method: 'POST',
      headers: {
        ...headers(token),
        'Idempotency-Key': crypto.randomUUID(),
      },
    }),

  cancelReservation: (token, reservationId) =>
    apiFetch(`/api/reservations/${reservationId}`, {
      method: 'DELETE',
      headers: {
        ...headers(token),
        'Idempotency-Key': crypto.randomUUID(),
      },
    }),

  // Waitlist
  joinWaitlist: (token, workshopId) =>
    apiFetch(`/api/workshops/${workshopId}/waitlist`, {
      method: 'POST',
      headers: {
        ...headers(token),
        'Idempotency-Key': crypto.randomUUID(),
      },
    }),

  leaveWaitlist: (token, workshopId) =>
    apiFetch(`/api/workshops/${workshopId}/waitlist`, {
      method: 'DELETE',
      headers: {
        ...headers(token),
        'Idempotency-Key': crypto.randomUUID(),
      },
    }),

  getWaitlistPosition: (token, workshopId) =>
    apiFetch(`/api/workshops/${workshopId}/waitlist/position`, {
      headers: headers(token),
    }),
};

export const confirmReservation = api.confirmHold;
export const cancelReservation = api.cancelReservation;
export const joinWaitlist = api.joinWaitlist;
export const leaveWaitlist = api.leaveWaitlist;
