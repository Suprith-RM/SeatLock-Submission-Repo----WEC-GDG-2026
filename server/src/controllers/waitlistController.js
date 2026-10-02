import * as waitlistService from '../services/waitlistService.js';

export async function joinWaitlist(req, res, next) {
  try {
    const entry = await waitlistService.joinWaitlist({
      userId:     req.user.id,
      workshopId: req.params.workshopId,
    });
    res.status(201).json({
      message: `Joined waitlist at position ${entry.position}.`,
      entry,
    });
  } catch (err) { next(err); }
}

export async function leaveWaitlist(req, res, next) {
  try {
    const entry = await waitlistService.leaveWaitlist({
      userId:     req.user.id,
      workshopId: req.params.workshopId,
    });
    res.json({ message: 'You have left the waitlist.', entry });
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
