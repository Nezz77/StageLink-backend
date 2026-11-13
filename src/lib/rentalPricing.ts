export type RentalRates = { hourlyRateMinor: number | null; dailyRateMinor: number; weeklyRateMinor: number | null };
export const rentalPeriods = [
  { unit: 'hour', field: 'hourlyRateMinor' },
  { unit: 'day', field: 'dailyRateMinor' },
  { unit: 'week', field: 'weeklyRateMinor' },
] as const;
export type RentalPeriod = typeof rentalPeriods[number]['unit'];

// A price estimate uses whole periods at the selected rate for one rental.
export function estimateRental(rates: RentalRates, unit: RentalPeriod, periods: number): number | null {
  const period = rentalPeriods.find(item => item.unit === unit);
  if (!period || !Number.isInteger(periods) || periods < 1 || periods > 1000) return null;
  const rate = rates[period.field];
  return rate === null ? null : rate * periods;
}
