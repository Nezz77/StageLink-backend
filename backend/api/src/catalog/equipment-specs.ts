import { z } from 'zod';

const measurement = (max: number) => z.string().trim().refine(value =>
  value === '' || (/^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0 && Number(value) <= max),
);
export const rentalSpecs = z.object({
  specWattage: measurement(1_000_000).optional(),
  specSpl: measurement(250).optional(),
  specFrequency: z.string().trim().max(120).optional(),
  specWeight: measurement(100_000).optional(),
  packageInclusions: z.string().trim().max(1000).optional(),
}).strict();
