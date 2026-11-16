import {Body,Controller,Get,HttpCode,Param,Post,Put,Patch,Req,Res,Query} from '@nestjs/common';
import {ApiTags,ApiHeader,ApiBearerAuth,ApiBody,ApiResponse,ApiParam,ApiQuery,ApiConsumes} from '@nestjs/swagger';
import type {Request,Response} from 'express';
import {z} from 'zod';
import {AuthService} from '../auth/service.js';
import {parse,PublicError} from '../auth/errors.js';
import {MediaStore} from '../../../shared/media-store.js';
import {MediaService} from './service.js';
import * as S from './schemas.js';
const json=(s:z.ZodType)=>z.toJSONSchema(s,{target:'openapi-3.0'})as any;
const body=(s:z.ZodType)=>({schema:json(s)}),response=(s:z.ZodType)=>({status:200,schema:json(s)});
const uuid=z.string().uuid(),kind=z.enum(['artist','renter']);
const errorSchema=json(z.object({statusCode:z.number(),code:z.string(),message:z.string(),requestId:z.string()}));
export function makeMediaControllers(auth:AuthService,store:MediaStore){
 const service=new MediaService(auth,store),actor=(req:Request)=>auth.authenticate(req.get('Authorization')),csrf=(req:Request)=>req.get('X-CSRF-Token');
 function mutation(req:Request,binary=false){if(req.get('Origin')!==auth.config.WEB_ORIGIN||req.get('Sec-Fetch-Site')==='cross-site'||!req.is(binary?'application/octet-stream':'application/json'))throw new PublicError(403,'ORIGIN_REJECTED','Open StageLink in its own browser tab and try again.');}
 @ApiTags('Media and portfolios') @ApiBearerAuth() @ApiHeader({name:'X-CSRF-Token',required:false,description:'Required for all authenticated mutations, including binary uploads.'})
 @ApiResponse({status:400,schema:errorSchema}) @ApiResponse({status:401,schema:errorSchema}) @ApiResponse({status:403,schema:errorSchema}) @ApiResponse({status:404,schema:errorSchema}) @ApiResponse({status:409,schema:errorSchema}) @ApiResponse({status:429,schema:errorSchema}) @ApiResponse({status:500,schema:errorSchema}) @ApiResponse({status:503,schema:errorSchema})
 @Controller()
 class MediaController {
  @Get('me/assets') @ApiResponse(response(S.library))
  async library(@Req()r:Request){return service.library(await actor(r));}
  @Post('assets/uploads') @HttpCode(200) @ApiBody(body(S.upload)) @ApiResponse(response(S.asset))
  async initiate(@Req()r:Request,@Body()b:unknown){mutation(r);return service.initiate(await actor(r),parse(S.upload,b),csrf(r));}
  @Put('assets/:id/content') @ApiParam({name:'id',format:'uuid'}) @ApiConsumes('application/octet-stream') @ApiBody({schema:{type:'string',format:'binary'}}) @ApiResponse(response(S.message))
  async upload(@Req()r:Request,@Param('id')id:string){mutation(r,true);return service.upload(await actor(r),parse(uuid,id),r,csrf(r));}
  @Post('assets/:id/finalize') @HttpCode(200) @ApiParam({name:'id',format:'uuid'}) @ApiBody(body(S.empty)) @ApiResponse(response(S.message))
  async finalize(@Req()r:Request,@Param('id')id:string,@Body()b:unknown){mutation(r);parse(S.empty,b);return service.finalize(await actor(r),parse(uuid,id),csrf(r));}
  @Post('assets/:id/remove') @HttpCode(200) @ApiParam({name:'id',format:'uuid'}) @ApiBody(body(S.empty)) @ApiResponse(response(S.message))
  async remove(@Req()r:Request,@Param('id')id:string,@Body()b:unknown){mutation(r);parse(S.empty,b);return service.remove(await actor(r),parse(uuid,id),csrf(r));}
  @Post('assets/:id/access') @HttpCode(200) @ApiParam({name:'id',format:'uuid'}) @ApiBody(body(S.access)) @ApiResponse(response(S.accessRead))
  async access(@Req()r:Request,@Param('id')id:string,@Body()b:unknown){mutation(r);return service.capability(await actor(r),parse(uuid,id),parse(S.access,b).variant,csrf(r));}
  @Put('me/avatar') @ApiBody(body(S.avatarBody)) @ApiResponse(response(S.message))
  async avatar(@Req()r:Request,@Body()b:unknown){mutation(r);return service.avatar(await actor(r),parse(S.avatarBody,b).assetId,csrf(r));}
  @Get('me/portfolio') @ApiResponse(response(S.portfolio))
  async portfolio(@Req()r:Request){return service.portfolio(await actor(r));}
  @Post('me/portfolio') @HttpCode(200) @ApiBody(body(S.itemWrite)) @ApiResponse(response(S.portfolio))
  async createItem(@Req()r:Request,@Body()b:unknown){mutation(r);return service.saveItem(await actor(r),parse(S.itemWrite,b),undefined,csrf(r));}
  @Patch('me/portfolio/:id') @ApiParam({name:'id',format:'uuid'}) @ApiBody(body(S.itemPatch)) @ApiResponse(response(S.portfolio))
  async patchItem(@Req()r:Request,@Param('id')id:string,@Body()b:unknown){mutation(r);return service.saveItem(await actor(r),parse(S.itemPatch,b),parse(uuid,id),csrf(r));}
  @Post('me/portfolio/:id/submit') @HttpCode(200) @ApiParam({name:'id',format:'uuid'}) @ApiBody(body(S.revision)) @ApiResponse(response(S.portfolio))
  async submitItem(@Req()r:Request,@Param('id')id:string,@Body()b:unknown){mutation(r);return service.itemAction(await actor(r),parse(uuid,id),parse(S.revision,b).revision,false,csrf(r));}
  @Post('me/portfolio/:id/remove') @HttpCode(200) @ApiParam({name:'id',format:'uuid'}) @ApiBody(body(S.revision)) @ApiResponse(response(S.portfolio))
  async removeItem(@Req()r:Request,@Param('id')id:string,@Body()b:unknown){mutation(r);return service.itemAction(await actor(r),parse(uuid,id),parse(S.revision,b).revision,true,csrf(r));}
  @Get('admin/media') @ApiResponse(response(S.reviewQueue))
  async queue(@Req()r:Request){return service.reviewQueue(await actor(r));}
  @Post('admin/media/:id/decision') @HttpCode(200) @ApiParam({name:'id',format:'uuid'}) @ApiBody(body(S.review)) @ApiResponse(response(S.message))
  async decision(@Req()r:Request,@Param('id')id:string,@Body()b:unknown){mutation(r);return service.review(await actor(r),parse(uuid,id),parse(S.review,b),csrf(r));}
 }
 @ApiTags('Media access') @ApiResponse({status:400,schema:errorSchema}) @ApiResponse({status:401,schema:errorSchema}) @ApiResponse({status:404,schema:errorSchema}) @ApiResponse({status:429,schema:errorSchema}) @ApiResponse({status:503,schema:errorSchema}) @Controller()
 class MediaContentController {
  @Get('public/providers/:userId/:kind/media') @ApiParam({name:'userId',format:'uuid'}) @ApiParam({name:'kind',enum:['artist','renter']}) @ApiResponse(response(S.portfolio))
  async publicPortfolio(@Param('userId')id:string,@Param('kind')k:string){return service.publicPortfolio(parse(uuid,id),parse(kind,k));}
  @Get('public/media/:id/access') @ApiParam({name:'id',format:'uuid'}) @ApiQuery({name:'variant',enum:['display','preview','poster']}) @ApiResponse(response(S.accessRead))
  async publicAccess(@Req()r:Request,@Param('id')id:string,@Query('variant')variant:string){return service.publicCapability(parse(uuid,id),parse(S.variant,variant),r.ip??'unknown');}
  @Get('media/content/:id') @ApiParam({name:'id',format:'uuid'}) @ApiQuery({name:'token',type:'string'}) @ApiResponse({status:200,description:'Validated media bytes; no original quarantine object is exposed.'})
  async content(@Req()r:Request,@Res()res:Response,@Param('id')id:string,@Query('token')token:string){const value=await service.content(parse(uuid,id),parse(z.string().max(2000),token),r.ip??'unknown');res.set({'Content-Type':value.mime,'Content-Length':value.bytes.length,'Content-Disposition':value.mime==='application/pdf'?'attachment; filename="verification-evidence.pdf"':'inline','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox",'Accept-Ranges':'none'}).send(value.bytes);}
 }
 return[MediaController,MediaContentController];
}
