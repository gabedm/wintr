import { createHash, randomBytes } from 'node:crypto';
import type { Handle } from '../shared/records.js';

export const newHandle = (): Handle => randomBytes(18).toString('base64url') as Handle;
export const newSecret = (): string => randomBytes(32).toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url');
