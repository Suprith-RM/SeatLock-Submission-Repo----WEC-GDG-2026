import { Router } from 'express';
import * as workshopController    from '../controllers/workshopController.js';
import * as reservationController from '../controllers/reservationController.js';
import * as waitlistController    from '../controllers/waitlistController.js';
import { authenticate }           from '../middleware/authMiddleware.js';
import { requireIdempotencyKey }  from '../middleware/idempotency.js';

const router = Router();

// Workshop catalog
router.get('/',                      workshopController.listWorkshops);
router.get('/:workshopId',           workshopController.getWorkshop);

// Reservations & holds
router.get('/:workshopId/my-reservation',
  authenticate, reservationController.getMyReservation);

router.post('/:workshopId/holds',
  authenticate, requireIdempotencyKey, reservationController.createHold);

// Waitlist
router.post('/:workshopId/waitlist',          authenticate, waitlistController.joinWaitlist);
router.delete('/:workshopId/waitlist',        authenticate, waitlistController.leaveWaitlist);
router.get('/:workshopId/waitlist/position',  authenticate, waitlistController.getWaitlistPosition);

export default router;
