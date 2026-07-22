import crypto from 'crypto';

export function canonicalJson(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).sort();
  const keyValues = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return '{' + keyValues.join(',') + '}';
}

export function computeSHA256Hex(obj: any): string {
  const compact = canonicalJson(obj);
  return crypto.createHash('sha256').update(compact, 'utf-8').digest('hex');
}

export function generateRandomHex(length: number): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export function parseTraceparent(tp?: string): { traceId: string; parentSpanId?: string } {
  if (tp && tp.startsWith('00-')) {
    const parts = tp.split('-');
    if (parts.length >= 4 && parts[1] !== '00000000000000000000000000000000') {
      return { traceId: parts[1], parentSpanId: parts[2] };
    }
  }
  return { traceId: generateRandomHex(32) };
}

export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

export function getCurrentUnixNano(): number {
  return Date.now() * 1000000;
}
