import { createHash } from 'node:crypto';

export async function pdfBodyDigest(response: Response, limit: number) {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const hash = createHash('sha256');
  const magic = Buffer.alloc(5);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes < magic.length) magic.set(value.subarray(0, magic.length - bytes), bytes);
      bytes += value.byteLength;
      if (bytes > limit) return null;
      hash.update(value);
    }
    const encoding = response.headers.get('Content-Encoding');
    if (magic.toString('ascii') !== '%PDF-' || (length !== null && (!encoding || encoding === 'identity') && bytes !== Number(length))) return null;
    return hash.digest('hex');
  } catch { return null; }
  finally { await reader.cancel().catch(() => undefined); }
}
