/**
 * Reservation routes.
 * All protected — authentication required.
 */
import { Router } from 'express';
import * as reservationController from '../controllers/reservationController.js';
import { authenticate }           from '../middleware/authMiddleware.js';
import { requireIdempotencyKey }  from '../middleware/idempotency.js';

const router = Router();

// GET /api/reservations/:reservationId
// Returns a specific reservation (must be owner)
router.get('/:reservationId',
  authenticate,
  reservationController.getReservation
);

// POST /api/reservations/:reservationId/confirm
// Confirms a HELD reservation before it expires
router.post('/:reservationId/confirm',
  authenticate,
  requireIdempotencyKey,
  reservationController.confirmHold
);

// DELETE /api/reservations/:reservationId
// Cancels a HELD or CONFIRMED reservation
router.delete('/:reservationId',
  authenticate,
  requireIdempotencyKey,
  reservationController.cancelReservation
);

export default router;
