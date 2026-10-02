import * as waitlistService from '../services/waitlistService.js';

export async function joinWaitlist(req, res, next) {
  try {
    const result = await waitlistService.joinWaitlist({
      userId:         req.user.id,
      workshopId:     req.params.workshopId,
      idempotencyKey: req.idempotencyKey,
      requestBody:    req.body,
    });
    if (result.fromCache) return res.status(result.cachedStatus).json(result.cachedBody);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function leaveWaitlist(req, res, next) {
  try {
    const result = await waitlistService.leaveWaitlist({
      userId:         req.user.id,
      workshopId:     req.params.workshopId,
      idempotencyKey: req.idempotencyKey,
      requestBody:    req.body,
    });
    if (result.fromCache) return res.status(result.cachedStatus).json(result.cachedBody);
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function getWaitlistPosition(req, res, next) {
  try {
    const result = await waitlistService.getWaitlistPosition({
      userId:     req.user.id,
      workshopId: req.params.workshopId,
    });
    res.json(result);
  } catch (err) { next(err); }
}
