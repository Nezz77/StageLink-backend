import type { InspectionPhase, InspectionStage } from '../../../generated/prisma/client.js';

export const draftPhase: Partial<Record<InspectionStage, InspectionPhase>> = {
  dispatch_draft: 'dispatch', return_draft: 'return', clearance_draft: 'clearance',
};

export const acknowledgmentPhase: Partial<Record<InspectionStage, 'dispatch' | 'return'>> = {
  dispatch_ack: 'dispatch', return_ack: 'return',
};

export function hasDiscrepancy(report: { units: { condition: string }[]; accessories: boolean[] }) {
  return report.units.some(unit => unit.condition === 'damaged' || unit.condition === 'missing') ||
    report.accessories.some(present => !present);
}
