// R2 public media helpers — tách nguyên từ src/worker.js.
export const PUBLIC_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isPublicMediaKey(key) {
  if (key === 'shop-logo.png' || key === 'shop-qr.png') return true;
  if (/^product-[a-z0-9]+\.(?:png|jpe?g|webp|gif)$/i.test(key)) return true;
  return /^public\/[a-z0-9/_-]+\.(?:png|jpe?g|webp|gif)$/i.test(key) && !key.includes('..');
}

export function publicMediaType(key, storedType) {
  if (PUBLIC_IMAGE_TYPES.has(storedType)) return storedType;
  if (/\.png$/i.test(key)) return 'image/png';
  if (/\.jpe?g$/i.test(key)) return 'image/jpeg';
  if (/\.webp$/i.test(key)) return 'image/webp';
  if (/\.gif$/i.test(key)) return 'image/gif';
  return 'application/octet-stream';
}
