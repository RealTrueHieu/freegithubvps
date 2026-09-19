// Validation helpers — tách nguyên từ src/worker.js.
// FIX: readRasterUpload chấp nhận thêm GIF magic bytes (GIF87a/GIF89a) cho khớp proxy R2
// (isPublicMediaKey/publicMediaType vốn đã cho phép .gif nhưng uploader cũ reject GIF).

export function isValidEmail(e) {
  return typeof e === 'string'
    && e.length >= 5
    && e.length <= 254
    && /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(e);
}

export function validateDisplayName(username) {
  if (typeof username !== 'string') throw new Error('Vui lòng nhập tên hiển thị');
  const value = username.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (value.length < 2 || value.length > 32) throw new Error('Tên hiển thị phải từ 2 đến 32 ký tự');
  if (!/^[\p{L}\p{N}._ -]+$/u.test(value)) {
    throw new Error('Tên hiển thị chỉ gồm chữ, số, khoảng trắng, chấm, gạch ngang và gạch dưới');
  }
  return value;
}

export async function readRasterUpload(file, maxBytes = 2 * 1024 * 1024) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Vui lòng chọn file ảnh');
  if (!file.size || file.size > maxBytes) throw new Error('Ảnh phải nhỏ hơn 2 MB');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { buffer, ext: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { buffer, ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return { buffer, ext: 'webp', contentType: 'image/webp' };
  }
  // FIX: chấp nhận GIF (GIF87a / GIF89a) cho khớp proxy R2 vốn đã serve .gif
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { buffer, ext: 'gif', contentType: 'image/gif' };
  }
  throw new Error('Chỉ hỗ trợ ảnh PNG, JPEG, WebP và GIF');
}
