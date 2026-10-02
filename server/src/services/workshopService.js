/**
 * Business logic for workshop queries and availability formatting.
 */
import * as workshopRepo from '../repositories/workshopRepository.js';
import { AppError, ErrorCode } from '../utils/errors.js';

export async function listWorkshops() {
  const rows = await workshopRepo.findAll();
  return rows.map(format);
}

export async function getWorkshop(id) {
  const workshop = await workshopRepo.findById(id);
  if (!workshop) {
    throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
  }
  return format(workshop);
}

function format(w) {
  const available = parseInt(w.available_seats ?? w.capacity, 10);
  return {
    id:             w.id,
    name:           w.name,
    description:    w.description,
    capacity:       parseInt(w.capacity, 10),
    activeCount:    parseInt(w.active_count ?? 0, 10),
    availableSeats: available,
    isFull:         available <= 0,
    createdAt:      w.created_at,
  };
}
