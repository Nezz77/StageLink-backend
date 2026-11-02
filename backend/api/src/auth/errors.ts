import { HttpException } from '@nestjs/common';
import type { z } from 'zod';
export class PublicError extends HttpException {
  constructor(status: number, public readonly code: string, public readonly publicMessage: string) {
    super(publicMessage, status);
  }
}
export const unauthorized = () => new PublicError(401, 'UNAUTHORIZED', 'Sign in again to continue.');
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new PublicError(400, 'INVALID_INPUT', 'Check your details. Use a valid email and a password of 12–128 characters.');
  return result.data;
}
