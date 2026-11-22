import {Controller,Get,Header,Req} from '@nestjs/common';
import {ApiBearerAuth,ApiOkResponse,ApiTags} from '@nestjs/swagger';
import type {Request} from 'express';
import {paymentCapabilities,paymentCapabilityView} from '../../../shared/payments/capabilities.js';
import {databaseNow} from '../../../shared/database-clock.js';
import type {AuthService} from '../auth/service.js';
import {schema} from './orders.js';

export function makePaymentCapabilitiesController(auth:AuthService){
 @ApiTags('Payment configuration capabilities')
 @ApiBearerAuth()
 @Controller('payments/capabilities')
 class PaymentCapabilitiesController{
  @Get()
  @Header('Cache-Control','no-store')
  @ApiOkResponse({schema:schema(paymentCapabilityView)})
  async read(@Req()req:Request){
   const actor=await auth.authenticate(req.get('Authorization'));
   const emailVerified=Boolean(actor.user.emailVerifiedAt);
   return{...paymentCapabilities(auth.config,{customerMembership:actor.user.roles.includes('customer'),emailVerified,adminViewer:actor.session.activeRole==='admin'&&emailVerified}),checkedAt:(await databaseNow(auth.deps.db)).toISOString()};
  }
 }
 return PaymentCapabilitiesController;
}
