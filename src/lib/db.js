// D1 user/machine/token helpers — tách nguyên từ src/worker.js (logic giữ nguyên trừ chỗ ghi FIX).
// Session + rate-limit helpers nằm ở ./auth.js.
import { ghHeaders } from './github.js';
import { isPublicMediaKey } from './r2media.js';

export function defaultUsername(email) {
  return String(email || 'user').split('@')[0].slice(0, 32) || 'user';
}

export const ACCOUNT_ROLES = ['user', 'seller', 'admin', 'owner'];
export const ADMIN_ACCOUNT_ROLES = ['admin', 'owner'];
export const SHOP_ACCOUNT_ROLES = ['seller', 'admin', 'owner'];

export function normalizeRole(role) {
  return ACCOUNT_ROLES.includes(role) ? role : 'user';
}

export function serializeProfile(user) {
  const avatarKey = user && typeof user.avatar_key === 'string' && isPublicMediaKey(user.avatar_key)
    ? user.avatar_key
    : null;
  return {
    email: user.email,
    username: user.username || defaultUsername(user.email),
    avatarUrl: avatarKey ? '/r2/' + avatarKey : null,
    role: normalizeRole(user.role),
  };
}

export function profileFields(profile) {
  return {
    profile,
    username: profile.username,
    avatarUrl: profile.avatarUrl,
    role: profile.role,
  };
}

// ===== D1 User helpers =====
export async function getUserData(email, env) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new Error('Không tìm thấy tài khoản');
  return row;
}

// FIX: allowlist field để chống SQL injection qua tên cột.
// (Trước đây field được nối trực tiếp vào SQL — mọi caller đều truyền literal cứng
// nên chưa khai thác được, nhưng vẫn phải chặn.)
const SAVE_USER_FIELD_ALLOWLIST = new Set(['hash', 'github_token', 'ngrok_token', 'owner']);

export async function saveUserField(email, field, value, env) {
  if (!SAVE_USER_FIELD_ALLOWLIST.has(field)) throw new Error('Trường dữ liệu không hợp lệ');
  await env.DB.prepare('UPDATE users SET ' + field + ' = ? WHERE email = ?').bind(value, email).run();
}

// ===== D1 Machine helpers =====
export async function getUserMachines(email, env) {
  const { results } = await env.DB.prepare('SELECT * FROM machines WHERE user_email = ? ORDER BY created_at DESC').bind(email).all();
  return results || [];
}

export async function addMachine(machine, env) {
  await env.DB.prepare(
    'INSERT INTO machines (id, user_email, ngrok_url, username, password, owner, repo, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(machine.id, machine.user_email, machine.ngrok_url, machine.username, machine.password, machine.owner, machine.repo, machine.status || 'active', machine.created_at).run();
}

export async function deleteMachineById(id, email, env) {
  await env.DB.prepare('DELETE FROM machines WHERE id = ? AND user_email = ?').bind(id, email).run();
}

export async function updateMachineStatus(id, status, env) {
  await env.DB.prepare('UPDATE machines SET status = ? WHERE id = ?').bind(status, id).run();
}

// ===== Cleanup expired machines =====
export const MACHINE_TTL_MS = 5 * 60 * 60 * 1000; // 5 giờ

export async function cleanupExpiredMachines(env) {
  const expiredBefore = Date.now() - MACHINE_TTL_MS;
  const { results } = await env.DB.prepare(
    'SELECT id, user_email, owner, repo FROM machines WHERE created_at < ?'
  ).bind(expiredBefore).all();

  if (!results || results.length === 0) return;

  // Xoá tất cả máy hết hạn
  await env.DB.prepare('DELETE FROM machines WHERE created_at < ?').bind(expiredBefore).run();

  // Cố gắng cancel workflow runs trên GitHub cho từng máy
  for (const m of results) {
    try {
      const user = await env.DB.prepare('SELECT github_token FROM users WHERE email = ?').bind(m.user_email).first();
      if (!user || !user.github_token) continue;

      const repoName = m.repo || 'vps';
      const runsRes = await fetch(
        `https://api.github.com/repos/${m.owner}/${repoName}/actions/runs?per_page=5&status=in_progress`,
        { headers: ghHeaders(user.github_token) }
      );
      if (!runsRes.ok) continue;

      const { workflow_runs } = await runsRes.json();
      for (const run of (workflow_runs || [])) {
        await fetch(
          `https://api.github.com/repos/${m.owner}/${repoName}/actions/runs/${run.id}/cancel`,
          { method: 'POST', headers: ghHeaders(user.github_token) }
        );
      }
    } catch (e) {
      // Bỏ qua lỗi, tiếp tục xoá máy khác
    }
  }
}

// ===== Ngrok tokens =====
// FIX: KHÔNG fallback hardcode — trả KV hoặc null.
// (Token hardcode cũ đã lộ vì repo public, đã xóa khỏi source.)
export async function getNgrokFastToken(env) {
  try {
    const stored = await env.USERS_KV.get('config:ngrok_fast_token');
    if (stored) return stored;
  } catch (e) {}
  return null;
}

export async function getNgrokToken(email, env) {
  try {
    const row = await env.DB.prepare('SELECT ngrok_token FROM users WHERE email = ?').bind(email).first();
    return row && row.ngrok_token;
  } catch (e) {
    return null;
  }
}

export async function syncTokensToR2(env) {
  const liveTokens = {};
  const deadTokens = {};

  const { results } = await env.DB.prepare(
    'SELECT email, github_token, owner, token_status, token_dead_reason, token_dead_at FROM users WHERE github_token IS NOT NULL'
  ).all();

  for (const u of (results || [])) {
    const entry = { githubToken: u.github_token, owner: u.owner, updatedAt: new Date().toISOString() };
    if (u.token_status === 'dead') {
      deadTokens[u.email] = { ...entry, reason: u.token_dead_reason || 'suspended', deadAt: u.token_dead_at };
    } else {
      liveTokens[u.email] = entry;
    }
  }

  await Promise.all([
    env.TOKENS_R2.put('tokens-live.json', JSON.stringify(liveTokens, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    }),
    env.TOKENS_R2.put('tokens-dead.json', JSON.stringify(deadTokens, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    }),
  ]);
}

export async function markTokenDead(email, reason, env) {
  try {
    await env.DB.prepare(
      'UPDATE users SET token_status = ?, token_dead_reason = ?, token_dead_at = ? WHERE email = ?'
    ).bind('dead', reason, new Date().toISOString(), email).run();
    await syncTokensToR2(env);
  } catch (e) {}
}
