/**
 * Reservation controller handling hold creation, confirmation, and cancellation.
 */
import * as holdService from '../services/holdService.js';

export async function createHold(req, res, next) {
  try {
    const result = await holdService.createHold({
      userId:         req.user.id,
      workshopId:     req.params.workshopId,
      idempotencyKey: req.idempotencyKey,
      requestPath:    req.path,
      requestBody:    req.body,
    });

    if (result.fromCache) {
      return res.status(result.cachedStatus ?? 200).json(result.cachedBody);
    }

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function confirmHold(req, res, next) {
  try {
    const result = await holdService.confirmHold({
      reservationId:  req.params.reservationId,
      userId:         req.user.id,
      idempotencyKey: req.idempotencyKey,
      requestBody:    req.body,
    });
    if (result.fromCache) return res.status(result.cachedStatus).json(result.cachedBody);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function cancelReservation(req, res, next) {
  try {
    const result = await holdService.cancelReservation({
      reservationId:  req.params.reservationId,
      userId:         req.user.id,
      idempotencyKey: req.idempotencyKey,
      requestBody:    req.body,
    });
    if (result.fromCache) return res.status(result.cachedStatus).json(result.cachedBody);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getReservation(req, res, next) {
  try {
    const reservation = await holdService.getReservation({
      reservationId: req.params.reservationId,
      userId:        req.user.id,
    });
    res.status(200).json({ reservation });
  } catch (err) {
    next(err);
  }
}

export async function getMyReservation(req, res, next) {
  try {
    const reservation = await holdService.getUserReservation({
      userId:     req.user.id,
      workshopId: req.params.workshopId,
    });
    res.status(200).json({ reservation });
  } catch (err) {
    next(err);
  }
}
