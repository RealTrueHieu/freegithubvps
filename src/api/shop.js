// Shop Backend — tách nguyên từ src/worker.js (logic giữ nguyên trừ chỗ ghi FIX).
// Dành cho seller (shop.trueteamcommunity.dpdns.org).
import { ADMIN_ACCOUNT_ROLES, SHOP_ACCOUNT_ROLES, getUserData, saveUserField, serializeProfile, profileFields } from '../lib/db.js';
import { assertLoginNotLocked, recordFailedLogin, clearLoginLock, generateSessionToken } from '../lib/auth.js';
import { readRasterUpload } from '../lib/validate.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { isPublicMediaKey } from '../lib/r2media.js';
import { handleShopConfig } from './user.js';

export async function handleShopAPI(path, request, env) {
  // Public endpoints — no session needed
  if (path === '/api/shop/login') {
    const body = request.method === 'POST' ? await request.json() : {};
    return shopLogin(body, env);
  }
  if (path === '/api/shop/products' && request.method === 'GET') {
    return getShopProducts(env);
  }
  if (path === '/api/shop/config' && request.method === 'GET') {
    return handleShopConfig(env);
  }

  // Check shop session from body or header
  let shopToken = null;
  const contentType = request.headers.get('content-type') || '';
  let body = {};
  if (contentType.includes('multipart/form-data')) {
    // FormData (upload) — shopToken comes from header
    shopToken = request.headers.get('shoptoken') || request.headers.get('shopToken');
  } else {
    body = request.method === 'POST' ? await request.json() : {};
    shopToken = body.shopToken;
  }

  const sellerEmail = await verifyShopSession(shopToken, env);
  if (!sellerEmail) throw new Error('Unauthorized');

  switch (path) {
    case '/api/shop/logout':
      await env.USERS_KV.delete('shop-session:' + shopToken);
      return { success: true };
    case '/api/shop/config': {
      const config = await getShopConfig(env);
      const user = await getUserData(sellerEmail, env);
      const profile = serializeProfile(user);
      return { ...config, ...profileFields(profile) };
    }
    case '/api/shop/save-bank-info': return saveShopBankInfo(body, sellerEmail, env);
    case '/api/shop/upload-logo': return shopUploadFile(request, env, 'shop-logo.png', sellerEmail);
    case '/api/shop/upload-qr': return shopUploadFile(request, env, 'shop-qr.png', sellerEmail);
    case '/api/shop/products': return getShopProducts(env);
    case '/api/shop/my-products': return getSellerProducts(sellerEmail, env);
    case '/api/shop/add-product': return addShopProduct(body, sellerEmail, env);
    case '/api/shop/delete-product': return deleteShopProduct(body, sellerEmail, env);
    case '/api/shop/upload-product-image': return shopUploadProductImage(request, env);
    default: throw new Error('Không tìm thấy');
  }
}

// FIX (spec): mọi case fail (không user / sai role / sai pass, kể cả thiếu field)
// trả CÙNG message 'Email hoặc mật khẩu không đúng' (chống enumerate), giữ rate-limit.
export async function shopLogin({ password, email }, env) {
  if (!email || !password) throw new Error('Email hoặc mật khẩu không đúng');
  await assertLoginNotLocked(email, env);
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    await recordFailedLogin(email, env);
    throw new Error('Email hoặc mật khẩu không đúng');
  }
  if (!SHOP_ACCOUNT_ROLES.includes(user.role)) {
    await recordFailedLogin(email, env);
    throw new Error('Email hoặc mật khẩu không đúng');
  }

  const verdict = await verifyPassword(password, user.hash);
  if (!verdict.ok) {
    await recordFailedLogin(email, env);
    throw new Error('Email hoặc mật khẩu không đúng');
  }
  await clearLoginLock(email, env);
  if (verdict.needsUpgrade) {
    const upgraded = await hashPassword(password);
    await saveUserField(email, 'hash', upgraded, env);
  }

  const token = generateSessionToken();
  const principal = JSON.stringify({ email, version: Number(user.session_version) || 0 });
  await env.USERS_KV.put('shop-session:' + token, principal, { expirationTtl: 24 * 3600 });
  const profile = serializeProfile(user);
  return { success: true, shopToken: token, email, ...profileFields(profile) };
}

export async function verifyShopSession(token, env) {
  if (!token) return null;
  const stored = await env.USERS_KV.get('shop-session:' + token);
  if (!stored) return null;
  let email = stored;
  let version = 0;
  try {
    const parsed = JSON.parse(stored);
    email = parsed.email;
    version = Number(parsed.version) || 0;
  } catch (e) {}
  const user = await env.DB.prepare(
    'SELECT role, COALESCE(session_version, 0) AS session_version FROM users WHERE email = ?'
  ).bind(email).first();
  if (!user || !SHOP_ACCOUNT_ROLES.includes(user.role) || (Number(user.session_version) || 0) !== version) {
    await env.USERS_KV.delete('shop-session:' + token);
    return null;
  }
  return email;
}

export async function getShopConfig(env) {
  const [bankName, bankAccount, bankHolder, bannerText] = await Promise.all([
    env.USERS_KV.get('config:shop_bank_name'),
    env.USERS_KV.get('config:shop_bank_account'),
    env.USERS_KV.get('config:shop_bank_holder'),
    env.USERS_KV.get('config:shop_banner_text'),
  ]);
  const logoR2 = await env.TOKENS_R2.get('shop-logo.png').catch(() => null);
  const qrR2 = await env.TOKENS_R2.get('shop-qr.png').catch(() => null);
  return {
    success: true,
    bankName: bankName || '',
    bankAccount: bankAccount || '',
    bankHolder: bankHolder || '',
    bannerText: bannerText || '🚀 TrueTeam Cloud — Free VPS for Everyone!',
    hasLogo: !!logoR2,
    hasQr: !!qrR2,
  };
}

// FIX (spec): ĐỔI signature nhận thêm sellerEmail — chỉ admin/owner được sửa
// bank info, seller thường → throw 'Unauthorized' (giữ nguyên chuỗi để router trả 401).
async function assertShopBankAdmin(sellerEmail, env) {
  const user = await getUserData(sellerEmail, env);
  if (!ADMIN_ACCOUNT_ROLES.includes(user.role)) throw new Error('Unauthorized');
  return user;
}

export async function saveShopBankInfo({ bankName, bankAccount, bankHolder, bannerText }, sellerEmail, env) {
  await assertShopBankAdmin(sellerEmail, env);
  await Promise.all([
    env.USERS_KV.put('config:shop_bank_name', bankName || ''),
    env.USERS_KV.put('config:shop_bank_account', bankAccount || ''),
    env.USERS_KV.put('config:shop_bank_holder', bankHolder || ''),
    env.USERS_KV.put('config:shop_banner_text', bannerText || ''),
  ]);
  return { success: true };
}

// FIX (spec): ĐỔI signature nhận thêm sellerEmail — chỉ admin/owner được upload logo/QR.
export async function shopUploadFile(request, env, key, sellerEmail) {
  await assertShopBankAdmin(sellerEmail, env);
  const formData = await request.formData();
  const file = formData.get('file');
  const upload = await readRasterUpload(file);

  await env.TOKENS_R2.put(key, upload.buffer, {
    httpMetadata: { contentType: upload.contentType },
  });

  return { success: true, url: '/r2/' + key };
}

// ============================================================
// Shop Products CRUD
// ============================================================
export async function ensureProductsTable(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price INTEGER DEFAULT 0,
      image_url TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      seller_email TEXT NOT NULL
    )`).run();
  } catch (e) {}
}

export async function getShopProducts(env) {
  await ensureProductsTable(env);
  const { results } = await env.DB.prepare(
    'SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC'
  ).all();
  return { success: true, products: results || [] };
}

export async function getSellerProducts(sellerEmail, env) {
  await ensureProductsTable(env);
  const { results } = await env.DB.prepare(
    'SELECT * FROM products WHERE seller_email = ? ORDER BY created_at DESC'
  ).bind(sellerEmail).all();
  return { success: true, products: results || [] };
}

// FIX (spec): validate price là số nguyên >= 0 (ép Math.floor(Number(price)),
// NaN/âm → throw 'Giá sản phẩm không hợp lệ').
export async function addShopProduct({ name, description, price, category, imageUrl }, sellerEmail, env) {
  if (!name) throw new Error('Vui lòng nhập tên sản phẩm');
  const parsedPrice = price === undefined || price === null || price === '' ? 0 : Math.floor(Number(price));
  if (!Number.isFinite(parsedPrice) || parsedPrice < 0) throw new Error('Giá sản phẩm không hợp lệ');
  await ensureProductsTable(env);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await env.DB.prepare(
    'INSERT INTO products (id, name, description, price, image_url, category, active, created_at, seller_email) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
  ).bind(id, name, description || '', parsedPrice, imageUrl || '', category || 'general', Date.now(), sellerEmail).run();
  return { success: true, id };
}

// FIX (spec): kiểm tra changes sau DELETE, 0 dòng → throw 'Không tìm thấy sản phẩm'.
export async function deleteShopProduct({ productId }, sellerEmail, env) {
  if (!productId) throw new Error('Thiếu ID sản phẩm');
  await ensureProductsTable(env);
  const product = await env.DB.prepare(
    'SELECT image_url FROM products WHERE id = ? AND seller_email = ?'
  ).bind(productId, sellerEmail).first();
  const del = await env.DB.prepare('DELETE FROM products WHERE id = ? AND seller_email = ?').bind(productId, sellerEmail).run();
  if ((del.meta?.changes ?? del.changes ?? 0) === 0) throw new Error('Không tìm thấy sản phẩm');
  const imageUrl = String(product?.image_url || '');
  const imagePrefix = '/r2/public/products/';
  if (imageUrl.startsWith(imagePrefix)) {
    const key = imageUrl.slice('/r2/'.length);
    const references = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM products WHERE image_url = ?'
    ).bind(imageUrl).first();
    if (isPublicMediaKey(key) && Number(references?.total || 0) === 0) {
      await env.TOKENS_R2.delete(key).catch(() => {});
    }
  }
  return { success: true };
}

export async function shopUploadProductImage(request, env) {
  const formData = await request.formData();
  const upload = await readRasterUpload(formData.get('file'));
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const key = 'public/products/' + id + '.' + upload.ext;
  await env.TOKENS_R2.put(key, upload.buffer, {
    httpMetadata: { contentType: upload.contentType },
  });
  return { success: true, url: '/r2/' + key };
}
