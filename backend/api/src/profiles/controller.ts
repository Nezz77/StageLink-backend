import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/service.js';
import { parse, PublicError } from '../auth/errors.js';
import { tokenSchema } from '../auth/schemas.js';
import { ProfileService } from './service.js';
import * as S from './schemas.js';
const json = (schema:z.ZodType) => z.toJSONSchema(schema,{target:'openapi-3.0'}) as any;
const body = (schema:z.ZodType) => ({schema:json(schema)});
const response = (schema:z.ZodType) => ({status:200,schema:json(schema)});
const error = json(z.object({statusCode:z.number(),code:z.string(),message:z.string(),requestId:z.string()}));
const uuid = z.string().uuid(), empty = z.object({}).strict();
export function makeProfileControllers(auth:AuthService){
  const service=new ProfileService(auth);
  function mutation(req:Request){if(req.get('Origin')!==auth.config.WEB_ORIGIN||!req.is('application/json')||req.get('Sec-Fetch-Site')==='cross-site')throw new PublicError(403,'ORIGIN_REJECTED','Open StageLink in its own browser tab and try again.');}
  const actor=(req:Request)=>auth.authenticate(req.get('Authorization'));
  const csrf=(req:Request)=>req.get('X-CSRF-Token');
  @ApiTags('Profiles and onboarding') @ApiBearerAuth()
  @ApiHeader({name:'X-CSRF-Token',required:false,description:'Required for all authenticated mutations.'})
  @ApiResponse({status:400,schema:error}) @ApiResponse({status:401,schema:error}) @ApiResponse({status:403,schema:error}) @ApiResponse({status:404,schema:error}) @ApiResponse({status:409,schema:error}) @ApiResponse({status:429,schema:error}) @ApiResponse({status:500,schema:error}) @ApiResponse({status:503,schema:error})
  @Controller()
  class ProfilesController {
    @Get('me/profile') @ApiResponse(response(S.memberRead))
    async profile(@Req() req:Request){return S.memberRead.parse(await service.member(await actor(req)));}
    @Put('me/profile') @ApiBody(body(S.memberWrite)) @ApiResponse(response(S.memberRead))
    async saveProfile(@Req() req:Request,@Body() input:unknown){mutation(req);return S.memberRead.parse(await service.saveMember(await actor(req),parse(S.memberWrite,input),csrf(req)));}
    @Get('me/providers/:kind') @ApiParam({name:'kind',enum:['artist','renter']}) @ApiResponse(response(S.providerEnvelope))
    async provider(@Req() req:Request,@Param('kind') kind:string){return S.providerEnvelope.parse(await service.provider(await actor(req),parse(S.providerKind,kind)));}
    @Put('me/providers/:kind') @ApiParam({name:'kind',enum:['artist','renter']}) @ApiBody(body(z.union([S.artistWrite,S.renterWrite]))) @ApiResponse(response(S.providerEnvelope))
    async saveProvider(@Req() req:Request,@Param('kind') raw:string,@Body() input:unknown){mutation(req);const kind=parse(S.providerKind,raw);const data=kind==='artist'?parse(S.artistWrite,input):parse(S.renterWrite,input);return S.providerEnvelope.parse(await service.saveProvider(await actor(req),kind,data,csrf(req)));}
    @Post('me/providers/:kind/submit') @HttpCode(200) @ApiParam({name:'kind',enum:['artist','renter']}) @ApiBody(body(S.revisionBody)) @ApiResponse(response(S.providerEnvelope))
    async submitProvider(@Req() req:Request,@Param('kind') kind:string,@Body() input:unknown){mutation(req);return S.providerEnvelope.parse(await service.submitProvider(await actor(req),parse(S.providerKind,kind),parse(S.revisionBody,input).revision,csrf(req)));}
    @Get('me/payout-destination') @ApiResponse(response(S.payoutEnvelope))
    async payout(@Req() req:Request){return S.payoutEnvelope.parse(await service.payout(await actor(req)));}
    @Put('me/payout-destination') @ApiBody(body(S.payoutWrite)) @ApiResponse(response(S.payoutEnvelope))
    async savePayout(@Req() req:Request,@Body() input:unknown){mutation(req);return S.payoutEnvelope.parse(await service.savePayout(await actor(req),parse(S.payoutWrite,input),csrf(req)));}
    @Get('me/email-change') @ApiResponse(response(S.emailPending))
    async emailChange(@Req() req:Request){return S.emailPending.parse(await service.pendingEmail(await actor(req)));}
    @Post('me/email-change') @HttpCode(202) @ApiBody(body(S.emailChangeBody)) @ApiResponse({status:202,schema:json(S.message)})
    async requestEmail(@Req() req:Request,@Body() input:unknown){mutation(req);const data=parse(S.emailChangeBody,input);return service.requestEmail(await actor(req),data.email,data.password,csrf(req));}
    @Post('me/email-change/cancel') @HttpCode(200) @ApiBody(body(empty)) @ApiResponse(response(S.message))
    async cancelEmail(@Req() req:Request,@Body() input:unknown){mutation(req);parse(empty,input);return service.cancelEmail(await actor(req),csrf(req));}
    @Get('admin/onboarding') @ApiResponse(response(S.reviewQueue))
    async queue(@Req() req:Request){return S.reviewQueue.parse(await service.queue(await actor(req)));}
    @Post('admin/providers/:userId/:kind/decision') @HttpCode(200) @ApiParam({name:'kind',enum:['artist','renter']}) @ApiParam({name:'userId',type:'string',format:'uuid'}) @ApiBody(body(S.decisionBody)) @ApiResponse(response(S.message))
    async reviewProvider(@Req() req:Request,@Param('userId') userId:string,@Param('kind') kind:string,@Body() input:unknown){mutation(req);return service.reviewProvider(await actor(req),parse(uuid,userId),parse(S.providerKind,kind),parse(S.decisionBody,input),csrf(req));}
    @Post('admin/payout-destinations/:userId/decision') @HttpCode(200) @ApiParam({name:'userId',type:'string',format:'uuid'}) @ApiBody(body(S.decisionBody)) @ApiResponse(response(S.message))
    async reviewPayout(@Req() req:Request,@Param('userId') userId:string,@Body() input:unknown){mutation(req);return service.reviewPayout(await actor(req),parse(uuid,userId),parse(S.decisionBody,input),csrf(req));}
  }
  @ApiTags('Public provider profiles') @ApiResponse({status:400,schema:error}) @ApiResponse({status:404,schema:error})
  @Controller()
  class PublicProfilesController {
    @Get('public/providers/:userId/:kind') @ApiParam({name:'kind',enum:['artist','renter']}) @ApiParam({name:'userId',type:'string',format:'uuid'}) @ApiResponse(response(S.providerPublic))
    async publicProfile(@Param('userId') userId:string,@Param('kind') kind:string){return service.publicProvider(parse(uuid,userId),parse(S.providerKind,kind));}
    @Post('auth/email-change/confirm') @HttpCode(200) @ApiBody(body(tokenSchema)) @ApiResponse(response(S.message)) @ApiResponse({status:401,schema:error}) @ApiResponse({status:403,schema:error}) @ApiResponse({status:409,schema:error}) @ApiResponse({status:429,schema:error})
    async confirmEmail(@Req() req:Request,@Body() input:unknown){mutation(req);return service.confirmEmailChange(parse(tokenSchema,input).token,req.ip??req.socket.remoteAddress??'unknown');}
  }
  return[ProfilesController,PublicProfilesController];
}
