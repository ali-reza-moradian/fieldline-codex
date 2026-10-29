import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const compress = promisify(gzip);
export function acceptsGzip(header = '') {
  return header.split(',').some(entry => {
    const [name, ...params] = entry.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return name.toLowerCase() === 'gzip' && (!q || Number(q.slice(2)) > 0);
  });
}
export async function responseBody(body, encoding, { etag = false } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gzipped = bytes.length >= 1024 && acceptsGzip(encoding);
  const content = gzipped ? await compress(bytes, { level: 1 }) : bytes;
  return { content, headers: {
    Vary: 'Accept-Encoding', 'Content-Length': content.length,
    ...(gzipped ? { 'Content-Encoding': 'gzip' } : {}),
    ...(etag ? { ETag: '"' + createHash('sha256').update(content).digest('base64url') + '"' } : {}),
  } };
}
