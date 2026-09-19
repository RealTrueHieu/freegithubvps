// Session + login rate-limit helpers — tách nguyên từ src/worker.js.
// THÊM MỚI (spec): destroySession(sessionToken, env) xóa `session:*` trong KV.
export function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(email, env) {
  const sessionToken = generateSessionToken();
  // Session hết hạn sau 7 ngày
  const user = await env.DB.prepare('SELECT COALESCE(session_version, 0) AS session_version FROM users WHERE email = ?').bind(email).first();
  if (!user) throw new Error('Không tìm thấy tài khoản');
  const principal = JSON.stringify({ email, version: Number(user.session_version) || 0 });
  await env.USERS_KV.put(`session:${sessionToken}`, principal, { expirationTtl: 7 * 24 * 3600 });
  return sessionToken;
}

export async function getEmailFromSession(sessionToken, env) {
  if (!sessionToken) throw new Error('Thiếu session token');
  const stored = await env.USERS_KV.get(`session:${sessionToken}`);
  if (!stored) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');

  let email = stored;
  let version = 0;
  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed.email === 'string') {
      email = parsed.email;
      version = Number(parsed.version) || 0;
    }
  } catch (e) {}

  const user = await env.DB.prepare('SELECT COALESCE(session_version, 0) AS session_version FROM users WHERE email = ?').bind(email).first();
  if (!user || (Number(user.session_version) || 0) !== version) {
    await env.USERS_KV.delete(`session:${sessionToken}`);
    throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  }
  return email;
}

// THÊM MỚI (spec): hủy session trong KV (dùng cho POST /api/logout)
export async function destroySession(sessionToken, env) {
  if (!sessionToken) return;
  await env.USERS_KV.delete(`session:${sessionToken}`).catch(() => {});
}

// ===== Login rate limit (per email, KV-backed) =====
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_LOCK_SECONDS = 600; // 10 phút

export async function loginAttemptKey(email) { return 'login_attempts:' + email.toLowerCase(); }

export async function assertLoginNotLocked(email, env) {
  const key = await loginAttemptKey(email);
  const v = await env.USERS_KV.get(key);
  const n = v ? parseInt(v, 10) : 0;
  if (n >= LOGIN_MAX_ATTEMPTS) {
    throw new Error('Quá nhiều lần đăng nhập sai. Thử lại sau ' + Math.ceil(LOGIN_LOCK_SECONDS / 60) + ' phút.');
  }
}

export async function recordFailedLogin(email, env) {
  const key = await loginAttemptKey(email);
  const v = await env.USERS_KV.get(key);
  const n = (v ? parseInt(v, 10) : 0) + 1;
  await env.USERS_KV.put(key, String(n), { expirationTtl: LOGIN_LOCK_SECONDS });
}

export async function clearLoginLock(email, env) {
  await env.USERS_KV.delete(await loginAttemptKey(email));
}
