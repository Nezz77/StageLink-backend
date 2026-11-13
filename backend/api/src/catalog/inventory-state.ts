import type { InventoryStatus } from '../../../generated/prisma/client.js';

const transitions: Record<InventoryStatus, readonly InventoryStatus[]> = {
  available: ['out', 'maintenance', 'quarantined', 'retired'],
  out: ['inspection'],
  inspection: ['available', 'maintenance', 'quarantined', 'retired'],
  maintenance: ['available', 'quarantined', 'retired'],
  quarantined: ['inspection', 'maintenance', 'retired'],
  retired: [],
};

export function canMoveUnit(from: InventoryStatus, to: InventoryStatus) {
  return transitions[from].includes(to);
}
