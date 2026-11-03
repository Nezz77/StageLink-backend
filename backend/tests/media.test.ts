import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {canonicalEmbed,upload} from '../api/src/media/schemas.js';
import {deriveMedia} from '../shared/media-processing.js';
test('media source validation allows only canonical video IDs and bounded image uploads',()=>{
 assert.equal(canonicalEmbed('https://youtu.be/dQw4w9WgXcQ?t=20'),'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
 assert.equal(canonicalEmbed('https://vimeo.com/123456789'),'https://player.vimeo.com/video/123456789');
 for(const bad of['http://youtube.com/watch?v=dQw4w9WgXcQ','https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ','https://user:secret@youtu.be/dQw4w9WgXcQ','https://vimeo.com/../config','https://youtu.be:8080/dQw4w9WgXcQ','file:///tmp/video'])assert.throws(()=>canonicalEmbed(bad));
 const input={filename:'owned.png',mime:'image/png',purpose:'avatar',bytes:100,sha256:'0'.repeat(64)};assert.ok(upload.safeParse(input).success);
 for(const extra of[{filename:'../secret'},{bytes:8*1024*1024+1},{mime:'image/svg+xml'},{ownerId:'forged'},{mime:'audio/mpeg'}])assert.ok(!upload.safeParse({...input,...extra}).success);
});
test('image processing decodes actual bytes, re-encodes and rejects forged MIME and oversized pixels',async()=>{
 const bytes=await sharp({create:{width:12,height:8,channels:3,background:'purple'}}).png().toBuffer();
 const result=await deriveMedia(bytes,'image/png');assert.equal(result.metadata.width,12);assert.equal((await sharp(result.variants.display!.bytes).metadata()).format,'webp');
 await assert.rejects(deriveMedia(bytes,'image/jpeg'));
 await assert.rejects(deriveMedia(Buffer.from('<svg/>'),'image/png'));
 const huge=await sharp({create:{width:4001,height:4000,channels:3,background:'black'}}).png().toBuffer();await assert.rejects(deriveMedia(huge,'image/png'));
});
