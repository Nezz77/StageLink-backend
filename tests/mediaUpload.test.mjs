import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateMediaFile} from '../src/lib/mediaUpload.ts';
test('upload picker rejects unsupported, empty, oversized and wrong-purpose media',()=>{
 assert.equal(validateMediaFile({size:100,type:'image/png'},'avatar'),'');
 assert.equal(validateMediaFile({size:20*1024*1024,type:'audio/mpeg'},'portfolio'),'');
 for(const [file,purpose]of[[{size:1,type:'image/svg+xml'},'avatar'],[{size:0,type:'image/png'},'avatar'],[{size:8*1024*1024+1,type:'image/png'},'avatar'],[{size:100,type:'video/mp4'},'evidence']])assert.notEqual(validateMediaFile(file,purpose),'');
});
