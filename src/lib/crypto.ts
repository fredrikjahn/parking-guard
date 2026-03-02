import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '@/lib/config';

type EncryptedPayload = {
  iv: string;
  data: string;
};

function getKey(): Buffer {
  const key = Buffer.from(config.TOKEN_ENCRYPTION_KEY_B64, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY_B64 must decode to 32 bytes for AES-256-GCM');
  }
  return key;
}

export function encryptJson(value: unknown): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const plaintext = JSON.stringify(value);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    data: `${encrypted.toString('base64')}.${authTag.toString('base64')}`,
  };
}

export function decryptJson<T>(payload: EncryptedPayload): T {
  const [ciphertextB64, tagB64] = payload.data.split('.');
  if (!ciphertextB64 || !tagB64) {
    throw new Error('Invalid encrypted payload format');
  }

  const iv = Buffer.from(payload.iv, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8')) as T;
}
