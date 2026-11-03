export const mediaTypes=['image/jpeg','image/png','image/webp','audio/mpeg','audio/wav','video/mp4','video/webm'];
export function validateMediaFile(file:{size:number;type:string},purpose:string){
 if(!mediaTypes.includes(file.type))return 'Choose a JPEG, PNG, WebP, MP3, WAV, MP4 or WebM file.';
 if(purpose!=='portfolio'&&!file.type.startsWith('image/'))return 'Choose an image for this upload purpose.';
 const max=file.type.startsWith('image/')?8:file.type.startsWith('audio/')?20:40;
 if(file.size<=0||file.size>max*1024*1024)return `Choose a file between 1 byte and ${max} MB.`;
 return '';
}
