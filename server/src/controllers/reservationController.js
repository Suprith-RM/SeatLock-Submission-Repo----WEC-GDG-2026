/**
 * Reservation controller handling hold creation, confirmation, and cancellation.
 */
import * as holdService from '../services/holdService.js';

export async function createHold(req, res, next) {
  try {
    const { workshopId } = req.params;
    const userId         = req.user.id;
    const idempotencyKey = req.idempotencyKey;

    const result = await holdService.createHold({
      userId,
      workshopId,
      idempotencyKey,
      requestPath: req.path,
      requestBody: { workshopId },
    });

    res.status(result.cached ? 200 : 201).json({
      message: result.cached
        ? 'Returning cached response for this Idempotency-Key.'
        : `Hold created. You have ${process.env.HOLD_DURATION_SECONDS || 300} seconds to confirm.`,
      reservation: result.reservation,
    });
  } catch (err) { next(err); }
}

export async function confirmHold(req, res, next) {
  try {
    const result = await holdService.confirmHold({
      reservationId: req.params.reservationId,
      userId:        req.user.id,
    });
    res.json({ message: 'Reservation confirmed.', reservation: result.reservation });
  } catch (err) { next(err); }
}

export async function cancelReservation(req, res, next) {
  try {
    const result = await holdService.cancelReservation({
      reservationId: req.params.reservationId,
      userId:        req.user.id,
    });
    res.json({ message: 'Reservation cancelled.', reservation: result.reservation });
  } catch (err) { next(err); }
}

export async function getReservation(req, res, next) {
  try {
    const reservation = await holdService.getReservation({
      reservationId: req.params.reservationId,
      userId:        req.user.id,
    });
    res.json({ reservation });
  } catch (err) { next(err); }
}

export async function getMyReservation(req, res, next) {
  try {
    const reservation = await holdService.getUserReservation({
      userId:     req.user.id,
      workshopId: req.params.workshopId,
    });
    res.json({ reservation });
  } catch (err) { next(err); }
}
