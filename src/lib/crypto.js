// Crypto helpers — tách nguyên từ src/worker.js (PBKDF2 dòng 1303-1362 giữ nguyên logic).
import nacl from 'tweetnacl';
import blake from 'blakejs';

// libsodium crypto_box_seal: ephemeral X25519 + blake2b nonce + xsalsa20poly1305
export function cryptoBoxSeal(message, recipientPk) {
  const eph = nacl.box.keyPair();
  const nonceInput = new Uint8Array(eph.publicKey.length + recipientPk.length);
  nonceInput.set(eph.publicKey, 0);
  nonceInput.set(recipientPk, eph.publicKey.length);
  const nonce = blake.blake2b(nonceInput, undefined, 24);
  const ct = nacl.box(message, nonce, recipientPk, eph.secretKey);
  const out = new Uint8Array(eph.publicKey.length + ct.length);
  out.set(eph.publicKey, 0);
  out.set(ct, eph.publicKey.length);
  return out;
}

export function b64decode(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
export function b64encode(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

// Legacy single-round SHA-256 (kept ONLY for backward-compat verification of old hashes)
export async function hashPasswordLegacy(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'free-vps-salt-2024');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function pbkdf2(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

export const PBKDF2_ITERS = 100000;

export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await pbkdf2(password, salt, PBKDF2_ITERS);
  return 'pbkdf2$' + PBKDF2_ITERS + '$' + bytesToHex(salt) + '$' + bytesToHex(derived);
}

// Constant-time string compare (prevent timing leaks)
export function constEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored) return { ok: false, needsUpgrade: false };
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length !== 4) return { ok: false, needsUpgrade: false };
    const iters = parseInt(parts[1], 10);
    const saltBytes = hexToBytes(parts[2]);
    const expected = parts[3];
    const computed = bytesToHex(await pbkdf2(password, saltBytes, iters));
    return { ok: constEq(computed, expected), needsUpgrade: iters < PBKDF2_ITERS };
  }
  // Legacy SHA-256 — verify and flag for upgrade
  const legacy = await hashPasswordLegacy(password);
  return { ok: constEq(legacy, stored), needsUpgrade: true };
}
