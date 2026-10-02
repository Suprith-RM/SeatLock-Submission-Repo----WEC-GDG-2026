import * as workshopService from '../services/workshopService.js';

export async function listWorkshops(req, res, next) {
  try {
    const workshops = await workshopService.listWorkshops();
    res.json({ workshops });
  } catch (err) { next(err); }
}

export async function getWorkshop(req, res, next) {
  try {
    const workshop = await workshopService.getWorkshop(req.params.workshopId);
    res.json({ workshop });
  } catch (err) { next(err); }
}
