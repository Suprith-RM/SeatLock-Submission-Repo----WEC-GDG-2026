/**
 * Workshop routes.
 * GET endpoints for browsing workshops are public (no auth required).
 * POST /holds is protected + requires Idempotency-Key.
 */
import { Router } from 'express';
import * as workshopController     from '../controllers/workshopController.js';
import * as reservationController  from '../controllers/reservationController.js';
import { authenticate }            from '../middleware/authMiddleware.js';
import { requireIdempotencyKey }   from '../middleware/idempotency.js';

const router = Router();

// GET /api/workshops
// Public — shows all workshops with live seat availability
router.get('/', workshopController.listWorkshops);

// GET /api/workshops/:workshopId
// Public — shows one workshop with live availability
router.get('/:workshopId', workshopController.getWorkshop);

// GET /api/workshops/:workshopId/my-reservation
// Protected — shows the current user's active reservation for this workshop (or null)
router.get('/:workshopId/my-reservation',
  authenticate,
  reservationController.getMyReservation
);

// POST /api/workshops/:workshopId/holds
// Protected + idempotency required
// Creates a HELD reservation with SELECT FOR UPDATE concurrency protection
router.post('/:workshopId/holds',
  authenticate,
  requireIdempotencyKey,
  reservationController.createHold
);

export default router;
