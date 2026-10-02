/**
 * Reservation routes.
 * All protected — authentication required.
 */
import { Router } from 'express';
import * as reservationController from '../controllers/reservationController.js';
import { authenticate }           from '../middleware/authMiddleware.js';

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
  reservationController.confirmHold
);

// DELETE /api/reservations/:reservationId
// Cancels a HELD or CONFIRMED reservation
router.delete('/:reservationId',
  authenticate,
  reservationController.cancelReservation
);

export default router;
