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
  const heldCount      = parseInt(w.heldCount ?? w.held_count ?? 0, 10);
  const confirmedCount = parseInt(w.confirmedCount ?? w.confirmed_count ?? 0, 10);
  const capacity       = parseInt(w.capacity, 10);
  const availableSeats = w.availableSeats !== undefined
    ? parseInt(w.availableSeats, 10)
    : Math.max(0, capacity - heldCount - confirmedCount);

  return {
    id:             w.id,
    name:           w.name,
    description:    w.description,
    capacity,
    heldCount,
    confirmedCount,
    activeCount:    heldCount + confirmedCount,
    availableSeats,
    isFull:         availableSeats <= 0,
    createdAt:      w.createdAt ?? w.created_at,
    updatedAt:      w.updatedAt ?? w.updated_at,
  };
}
