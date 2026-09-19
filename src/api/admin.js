// Admin Backend — tách nguyên từ src/worker.js (logic giữ nguyên trừ chỗ ghi FIX).
// Route giữ nguyên path, thêm POST /api/admin/logout.
import { generateSessionToken, assertLoginNotLocked, recordFailedLogin, clearLoginLock } from '../lib/auth.js';
import {
  ADMIN_ACCOUNT_ROLES,
  ACCOUNT_ROLES,
  defaultUsername,
  getUserData,
  saveUserField,
  syncTokensToR2,
  getNgrokFastToken,
  MACHINE_TTL_MS,
} from '../lib/db.js';
import { isPublicMediaKey } from '../lib/r2media.js';
import { hashPassword, verifyPassword, constEq } from '../lib/crypto.js';
import { checkGithubToken } from '../lib/github.js';

const ADMIN_SESSION_TTL = 24 * 3600;
const TOKEN_CHECK_CHUNK_SIZE = 10;

export async function handleAdminAPI(path, request, env) {
  const body = request.method === 'POST' ? await request.json() : {};

  // Login không cần session
  if (path === '/api/admin/login') return adminLogin(body, env);

  // Tất cả endpoint khác cần admin session
  const adminEmail = await verifyAdminSession(body.adminToken, env);
  if (!adminEmail) throw new Error('Unauthorized');

  switch (path) {
    case '/api/admin/logout': return adminLogout(body, env);
    case '/api/admin/users': return adminGetUsers(env);
    case '/api/admin/tokens': return adminGetTokens(env);
    case '/api/admin/machines': return adminGetMachines(env);
    case '/api/admin/reset-password': return adminResetPassword(body, env);
    case '/api/admin/delete-user': return adminDeleteUser(body, env);
    case '/api/admin/revoke-token': return adminRevokeToken(body, env);
    case '/api/admin/check-tokens': return adminCheckTokens(body, env);
    case '/api/admin/get-ngrok-fast-token': return adminGetNgrokFastToken(env);
    case '/api/admin/set-ngrok-fast-token': return adminSetNgrokFastToken(body, env);
    case '/api/admin/set-role': return adminSetRole(body, env);
    default: throw new Error('Không tìm thấy');
  }
}

export async function adminLogin({ password, email }, env) {
  if (!password) throw new Error('Thông tin đăng nhập không đúng');
  // Trim trailing newlines (wrangler secret may have trailing \n from echo pipe)
  const cleanPassword = typeof password === 'string' ? password.trim() : password;

  // Rate-limit (key by email if provided, else by 'master')
  const rlEmail = email || '__admin_master__';
  await assertLoginNotLocked(rlEmail, env);

  let authorized = false;
  let principal = { kind: 'master' };

  // Cách 1: ADMIN_PASS secret (master password) — constant-time compare (giữ nguyên)
  // Trim trailing newline from env secret (wrangler piped input may include \n)
  const adminPass = typeof env.ADMIN_PASS === 'string' ? env.ADMIN_PASS.trim() : env.ADMIN_PASS;
  if (adminPass && constEq(cleanPassword, adminPass)) {
    authorized = true;
  }

  // Cách 2: User có role "admin" hoặc "owner" login bằng email + password
  if (!authorized && email) {
    try {
      const user = await getUserData(email, env);
      if (ADMIN_ACCOUNT_ROLES.includes(user.role)) {
        const verdict = await verifyPassword(password, user.hash);
        if (verdict.ok) {
          authorized = true;
          principal = { kind: 'account', email, version: Number(user.session_version) || 0 };
          if (verdict.needsUpgrade) {
            try {
              const upgraded = await hashPassword(password);
              await saveUserField(email, 'hash', upgraded, env);
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  if (!authorized) {
    await recordFailedLogin(rlEmail, env);
    throw new Error('Thông tin đăng nhập không đúng');
  }
  await clearLoginLock(rlEmail, env);

  const token = generateSessionToken();
  await env.USERS_KV.put('admin-session:' + token, JSON.stringify(principal), { expirationTtl: ADMIN_SESSION_TTL });
  return { success: true, adminToken: token };
}

// THÊM MỚI (spec): POST /api/admin/logout — xóa admin-session trong KV
export async function adminLogout({ adminToken }, env) {
  if (adminToken) {
    await env.USERS_KV.delete('admin-session:' + adminToken).catch(() => {});
  }
  return { success: true };
}

// FIX (spec): bỏ nhánh check `kind` admin/owner chết — chỉ giữ master/account.
export async function verifyAdminSession(token, env) {
  if (!token) return null;
  const val = await env.USERS_KV.get('admin-session:' + token);
  if (!val) return null;
  if (val === 'admin') return { kind: 'master' };
  try {
    const principal = JSON.parse(val);
    if (principal.kind === 'master') return principal;
    if (principal.kind === 'account' && principal.email) {
      const user = await env.DB.prepare(
        'SELECT role, COALESCE(session_version, 0) AS session_version FROM users WHERE email = ?'
      ).bind(principal.email).first();
      if (user && ADMIN_ACCOUNT_ROLES.includes(user.role) && (Number(user.session_version) || 0) === (Number(principal.version) || 0)) {
        return principal;
      }
    }
  } catch (e) {}
  await env.USERS_KV.delete('admin-session:' + token);
  return null;
}

export async function adminGetUsers(env) {
  const { results: users } = await env.DB.prepare(
    'SELECT u.*, (SELECT COUNT(*) FROM machines m WHERE m.user_email = u.email) as machine_count FROM users u ORDER BY u.created_at DESC'
  ).all();
  return {
    success: true,
    total: users.length,
    users: users.map(u => ({
      email: u.email,
      username: u.username || defaultUsername(u.email),
      avatarUrl: u.avatar_key && isPublicMediaKey(u.avatar_key) ? '/r2/' + u.avatar_key : null,
      createdAt: u.created_at,
      hasToken: !!u.github_token,
      tokenStatus: u.token_status || 'active',
      owner: u.owner || null,
      machineCount: u.machine_count,
      role: u.role,
    })),
  };
}

export async function adminGetTokens(env) {
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN ngrok_token TEXT').run();
  } catch (e) {}

  const { results } = await env.DB.prepare(
    'SELECT email, github_token, ngrok_token, owner, token_status, token_dead_reason, token_dead_at FROM users WHERE github_token IS NOT NULL OR ngrok_token IS NOT NULL'
  ).all();

  const tokens = (results || []).map(u => ({
    email: u.email,
    githubToken: u.github_token || null,
    ngrokToken: u.ngrok_token || null,
    owner: u.owner || null,
    status: u.token_status || 'active',
    deadReason: u.token_dead_reason || null,
    deadAt: u.token_dead_at || null,
  }));

  return {
    success: true,
    tokens,
    liveCount: tokens.filter(t => t.status !== 'dead').length,
    deadCount: tokens.filter(t => t.status === 'dead').length,
  };
}

export async function adminGetMachines(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM machines ORDER BY created_at DESC'
  ).all();

  const machines = (results || []).map(m => ({
    ...m,
    userEmail: m.user_email,
    createdAt: m.created_at,
    isExpired: (Date.now() - m.created_at) > MACHINE_TTL_MS,
  }));

  return { success: true, machines, total: machines.length };
}

export async function adminResetPassword({ email, newPassword }, env) {
  if (!email || !newPassword) throw new Error('Vui lòng nhập email và mật khẩu mới');
  if (newPassword.length < 6) throw new Error('Mật khẩu phải từ 6 ký tự trở lên');
  if (newPassword.length > 200) throw new Error('Mật khẩu quá dài');
  const hash = await hashPassword(newPassword);
  await env.DB.prepare(
    'UPDATE users SET hash = ?, session_version = COALESCE(session_version, 0) + 1 WHERE email = ?'
  ).bind(hash, email).run();
  return { success: true, email };
}

// FIX (spec): xóa thêm avatar R2 của user + gọi syncTokensToR2 sau xóa.
export async function adminDeleteUser({ email }, env) {
  if (!email) throw new Error('Vui lòng nhập email');
  let avatarKey = null;
  try {
    const user = await env.DB.prepare('SELECT avatar_key FROM users WHERE email = ?').bind(email).first();
    avatarKey = user?.avatar_key || null;
  } catch (e) {}
  await env.DB.prepare('DELETE FROM machines WHERE user_email = ?').bind(email).run();
  await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
  if (avatarKey && typeof avatarKey === 'string' && /^public\/avatars\//.test(avatarKey)) {
    await env.TOKENS_R2.delete(avatarKey).catch(() => {});
  }
  await syncTokensToR2(env);
  return { success: true, email };
}

export async function adminRevokeToken({ email }, env) {
  if (!email) throw new Error('Vui lòng nhập email');
  const user = await getUserData(email, env);
  const oldToken = user.github_token;
  await env.DB.prepare(
    'UPDATE users SET github_token = NULL, token_status = ?, token_dead_reason = NULL, token_dead_at = NULL WHERE email = ?'
  ).bind('active', email).run();
  await syncTokensToR2(env);
  return { success: true, email, revokedToken: oldToken };
}

// FIX (spec): không còn defaultToken hardcode — chỉ trả KV hoặc null.
// Giữ shape {success, token, overridden} để frontend cũ vẫn chạy;
// frontend hiển thị "token mặc định trong code" sẽ thành "chưa cấu hình" khi token null.
export async function adminGetNgrokFastToken(env) {
  const value = await getNgrokFastToken(env);
  const overridden = !!(await env.USERS_KV.get('config:ngrok_fast_token').catch(() => null));
  return { success: true, token: value, overridden };
}

export async function adminSetNgrokFastToken({ token, reset }, env) {
  if (reset) {
    await env.USERS_KV.delete('config:ngrok_fast_token');
    return { success: true, reset: true, token: null };
  }
  if (!token || typeof token !== 'string' || token.length < 10) {
    throw new Error('Ngrok token không hợp lệ');
  }
  await env.USERS_KV.put('config:ngrok_fast_token', token.trim());
  return { success: true, token: token.trim() };
}

// FIX (spec): chia chunk 10 email/lượt (for loop + Promise.all từng chunk)
// thay vì Promise.all toàn bộ (tránh burst rate-limit GitHub API).
export async function adminCheckTokens({ emails }, env) {
  let query = 'SELECT email, github_token FROM users WHERE github_token IS NOT NULL';
  let bindings = [];
  if (Array.isArray(emails) && emails.length) {
    const placeholders = emails.map(() => '?').join(',');
    query += ' AND email IN (' + placeholders + ')';
    bindings = emails;
  }
  const stmt = env.DB.prepare(query);
  const { results } = bindings.length ? await stmt.bind(...bindings).all() : await stmt.all();

  const rows = results || [];
  const checks = [];
  for (let i = 0; i < rows.length; i += TOKEN_CHECK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + TOKEN_CHECK_CHUNK_SIZE);
    const chunkResults = await Promise.all(chunk.map(async (u) => {
      const r = await checkGithubToken(u.github_token);
      return { email: u.email, alive: r.alive, reason: r.reason || null, login: r.login || null, status: r.status };
    }));
    checks.push(...chunkResults);
  }

  const now = new Date().toISOString();
  for (const c of checks) {
    if (c.alive) {
      await env.DB.prepare(
        'UPDATE users SET token_status = ?, token_dead_reason = NULL, token_dead_at = NULL WHERE email = ?'
      ).bind('active', c.email).run();
    } else {
      await env.DB.prepare(
        'UPDATE users SET token_status = ?, token_dead_reason = ?, token_dead_at = ? WHERE email = ?'
      ).bind('dead', c.reason || 'dead', now, c.email).run();
    }
  }
  await syncTokensToR2(env);

  return {
    success: true,
    total: checks.length,
    aliveCount: checks.filter(c => c.alive).length,
    deadCount: checks.filter(c => !c.alive).length,
    results: checks,
  };
}

export async function adminSetRole({ email, role }, env) {
  if (!email || !role) throw new Error('Vui lòng nhập email và role');
  if (!ACCOUNT_ROLES.includes(role)) throw new Error('Role không hợp lệ. Giá trị cho phép: ' + ACCOUNT_ROLES.join(', '));
  await env.DB.prepare('UPDATE users SET role = ? WHERE email = ?').bind(role, email).run();
  return { success: true, email, role };
}
