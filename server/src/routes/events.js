import { Router } from 'express';
import * as eventsController from '../controllers/eventsController.js';
import { authenticate }      from '../middleware/authMiddleware.js';

const router = Router();

router.get('/workshop/:workshopId', authenticate, eventsController.subscribe);

export default router;
