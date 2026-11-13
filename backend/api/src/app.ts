import 'reflect-metadata';
import { Catch, Controller, ExceptionFilter, Get, HttpException, Module, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiOkResponse, ApiProperty, ApiResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../../shared/config.js';
import { closeResources, readiness, resources, type Resources } from '../../shared/resources.js';
import { log } from '../../shared/log.js';
import { AuthService } from './auth/service.js';
import { makeSupportController } from './support/cases.js';
import { makeVerificationController } from './verification/cases.js';
import { makeRecommendationController } from './ai/recommendations.js';
import { makePromptController } from './ai/prompts.js';
import { makeAiOperationsController } from './ai/operations.js';
import { makeAuthController } from './auth/controller.js';
import { makeProfileControllers } from './profiles/controller.js';
import { makeMediaControllers } from './media/controller.js';
import { makeGigControllers } from './catalog/gigs.js';
import { makeRentalControllers } from './catalog/rentals.js';
import { makeInventoryController } from './catalog/inventory.js';
import { makeRentalGalleryControllers } from './catalog/rental-gallery.js';
import { makePublicFeedController } from './catalog/public-feed.js';
import { makeEventBriefController } from './events/briefs.js';
import { makeSavedItemsController } from './catalog/saved-items.js';
import { makeDraftsController } from './events/drafts.js';
import { makeInquiriesController } from './events/inquiries.js';
import { makeAvailabilityControllers } from './availability/calendars.js';
import { makeDamageClaimsController } from './bookings/damage-claims.js';
import { makeInspectionsController } from './bookings/inspections.js';
import { makeReviewsController } from './bookings/reviews.js';
import { makeRefundsController } from './bookings/refunds.js';
import { makeDocumentsController } from './bookings/documents.js';
import { makeCompletionController } from './bookings/completion.js';
import { makeBookingRequestsController } from './bookings/requests.js';
import { makeQuotationsController } from './bookings/quotations.js';
import { makeBookingMessagesController } from './bookings/messages.js';
import { makePayoutsController } from './payments/payouts.js';
import { makePaymentOrdersController } from './payments/orders.js';
import { makePayHereController } from './payments/payhere.js';
import { makeStripeController } from './payments/stripe.js';
import { MediaStore } from '../../shared/media-store.js';
import { PublicError } from './auth/errors.js';

class LiveResponse {
  @ApiProperty({ type: String, enum: ['alive'] }) status!: string;
  @ApiProperty({ type: String, example: 'stagelink-api' }) service!: string;
  @ApiProperty({ type: String, example: '0.1.0' }) version!: string;
}
class Dependencies {
  @ApiProperty({ type: String, enum: ['up', 'down'] }) postgres!: string;
  @ApiProperty({ type: String, enum: ['up', 'down'] }) redis!: string;
}
class ReadyResponse {
  @ApiProperty({ type: String, enum: ['ready', 'unavailable'] }) status!: string;
  @ApiProperty({ type: Dependencies }) dependencies!: Dependencies;
  @ApiProperty({ type: String, nullable: true }) schemaVersion!: string | null;
}
class ErrorResponse {
  @ApiProperty({ type: Number }) statusCode!: number;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
  @ApiProperty({ type: String }) requestId!: string;
}

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const code = error instanceof PublicError ? error.code : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : status === 400 ? 'BAD_REQUEST' :
      status === 503 ? 'DEPENDENCIES_UNAVAILABLE' : 'INTERNAL_ERROR';
    const message = error instanceof PublicError ? error.publicMessage : status === 401 ? 'Sign in again to continue.' : status === 403 ? 'Access denied.' : status === 429 ? 'Too many attempts.' : status === 404 ? 'Resource not found' : status === 400 ? 'Invalid request' :
      status === 503 ? 'Required services are unavailable' : 'An unexpected error occurred';
    res.status(status).json({ statusCode: status, code, message, requestId: res.locals.requestId });
  }
}

export async function createApp(config: Config, dependencies: Resources = resources(config)) {
  @Controller('health')
  class HealthController {
    @Get('live')
    @ApiOkResponse({ type: LiveResponse })
    live() { return { status: 'alive', service: 'stagelink-api', version: '0.1.0' }; }

    @Get('ready')
    @ApiOkResponse({ type: ReadyResponse })
    @ApiResponse({ status: 503, type: ErrorResponse })
    async ready() {
      const health = await readiness(dependencies);
      if (health.status !== 'ready') throw new ServiceUnavailableException();
      return health;
    }
  }
  const auth = new AuthService(config, dependencies);
  const mediaStore = new MediaStore(config);
  @Module({ controllers: [HealthController, makeAuthController(auth), makeAiOperationsController(auth), makePromptController(auth), makeRecommendationController(auth), makeVerificationController(auth), makeSupportController(auth), ...makeProfileControllers(auth), ...makeMediaControllers(auth, mediaStore), ...makeGigControllers(auth), ...makeRentalControllers(auth), makeInventoryController(auth), ...makeRentalGalleryControllers(auth), makePublicFeedController(dependencies.db), makeEventBriefController(auth), makeSavedItemsController(auth), makeDraftsController(auth), makeInquiriesController(auth), ...makeAvailabilityControllers(auth), makeBookingRequestsController(auth), makeQuotationsController(auth), makeBookingMessagesController(auth), makeCompletionController(auth), makeRefundsController(auth), makeDocumentsController(auth, mediaStore), makeReviewsController(auth, mediaStore), makeInspectionsController(auth), makeDamageClaimsController(auth), makePaymentOrdersController(auth), makePayoutsController(auth), makePayHereController(auth), makeStripeController(auth)] })
  class AppModule {
    async onApplicationShutdown() { mediaStore.close(); await closeResources(dependencies); }
  }
  const app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Server-owned ID; never echo arbitrary untrusted header data into logs.
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const started = performance.now();
    res.on('finish', () => log('http.request', {
      requestId: res.locals.requestId, method: req.method, status: res.statusCode,
      durationMs: Math.round(performance.now() - started),
    }));
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new Errors());
  const document = openApi(app);
  // Interactive documentation is local/development-only; committed JSON is the contract.
  if (config.NODE_ENV !== 'production') SwaggerModule.setup('api/docs', app, document);
  app.enableShutdownHooks();
  return { app, document };
}
export function openApi(app: INestApplication) {
  return SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('StageLink API').setDescription('Accounts, profiles, media, onboarding, artist gigs, equipment listings and infrastructure. Other business endpoints follow per phase.')
    .addBearerAuth().addCookieAuth('stagelink_refresh')
    .setVersion('0.1.0').build());
}
