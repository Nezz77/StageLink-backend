import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Resources } from '../../../shared/resources.js';
import { PublicError } from '../auth/errors.js';

const reads = new Set(['GET', 'HEAD', 'OPTIONS']);
const availableActions = new Set([
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'POST /api/v1/assets/:id/access',
  'POST /api/v1/auth/password-reset',
  'POST /api/v1/auth/password-reset/verify',
  'POST /api/v1/auth/password-reset/complete',
  'POST /api/v1/payments/webhooks/payhere',
  'POST /api/v1/payments/webhooks/stripe',
  'PUT /api/v1/admin/system/maintenance',
  'PUT /api/v1/admin/announcements',
  'POST /api/v1/admin/cache/invalidate',
  'POST /api/v1/admin/sessions/revoke',
]);

export function makeMaintenanceGuard(db: Resources['db']): CanActivate {
  return {
    async canActivate(context: ExecutionContext) {
      const http = context.switchToHttp();
      const req = http.getRequest<Request>();
      if (reads.has(req.method) || availableActions.has(req.method + ' ' + req.route?.path)) return true;
      const state = await db.systemSetting.findUniqueOrThrow({ where: { id: 1 }, select: { maintenance: true, maintenanceMessage: true } });
      if (!state.maintenance) return true;
      http.getResponse<Response>().setHeader('Retry-After', '60');
      throw new PublicError(503, 'MAINTENANCE_MODE', state.maintenanceMessage ?? 'StageLink is temporarily read-only.');
    },
  };
}
