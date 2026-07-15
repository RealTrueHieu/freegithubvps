// ============================================================
// Free VPS GitHub — Cloudflare Worker (Session + Persist)
// ============================================================

import nacl from 'tweetnacl';
import blake from 'blakejs';
import { WF_VNC_B64, WF_BORE_B64, WF_NGROK_B64 } from './workflows.js';
import COMMUNITY_ART from '../frontend/assets/community-art.webp';
import CONSOLE_SHELL from '../frontend/console-shell.html';

const MODES = {
  vnc: {
    repoName: 'vps-novnc',
    workflowFile: 'rdp.yml',
    outputFile: 'remote-link.txt',
    defaultUsername: '(noVNC)',
    defaultPassword: 'hieudz',
    needsNgrokToken: false,
    workflowB64: WF_VNC_B64,
  },
  bore: {
    repoName: 'vps-bore',
    workflowFile: 'rdp.yml',
    outputFile: 'rdp_info.txt',
    defaultUsername: 'admin',
    defaultPassword: 'WindowsRDP2026@',
    needsNgrokToken: false,
    workflowB64: WF_BORE_B64,
  },
  ngrok: {
    repoName: 'vps-ngrok',
    workflowFile: 'rdp.yml',
    outputFile: 'rdp_info.txt',
    defaultUsername: 'DucthengTechDz',
    defaultPassword: 'W1nd0ws-P4ssw0rd-2025!',
    needsNgrokToken: true,
    workflowB64: WF_NGROK_B64,
  },
  ngrok_fast: {
    repoName: 'vps-ngrok',
    workflowFile: 'rdp.yml',
    outputFile: 'rdp_info.txt',
    defaultUsername: 'DucthengTechDz',
    defaultPassword: 'W1nd0ws-P4ssw0rd-2025!',
    needsNgrokToken: false,
    presetNgrokToken: '3CvOG06NqLY412YffC37tKzhW7p_85AE6Jk2VntQ9sJ1YUA9x',
    workflowB64: WF_NGROK_B64,
  },
};
const DEFAULT_MODE = 'vnc';
function getMode(m) { return MODES[m] ? m : DEFAULT_MODE; }

const PUBLIC_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function isPublicMediaKey(key) {
  if (key === 'shop-logo.png' || key === 'shop-qr.png') return true;
  if (/^product-[a-z0-9]+\.(?:png|jpe?g|webp|gif)$/i.test(key)) return true;
  return /^public\/[a-z0-9/_-]+\.(?:png|jpe?g|webp|gif)$/i.test(key) && !key.includes('..');
}

function publicMediaType(key, storedType) {
  if (PUBLIC_IMAGE_TYPES.has(storedType)) return storedType;
  if (/\.png$/i.test(key)) return 'image/png';
  if (/\.jpe?g$/i.test(key)) return 'image/jpeg';
  if (/\.webp$/i.test(key)) return 'image/webp';
  if (/\.gif$/i.test(key)) return 'image/gif';
  return 'application/octet-stream';
}

// libsodium crypto_box_seal: ephemeral X25519 + blake2b nonce + xsalsa20poly1305
function cryptoBoxSeal(message, recipientPk) {
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
function b64decode(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function b64encode(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

async function setActionsSecret(token, owner, repo, secretName, secretValue) {
  const keyRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
    { headers: ghHeaders(token) }
  );
  if (!keyRes.ok) {
    const err = await keyRes.json().catch(() => ({}));
    throw new Error('Get public-key fail: ' + (err.message || keyRes.status));
  }
  const { key, key_id } = await keyRes.json();
  const recipientPk = b64decode(key);
  const messageBytes = new TextEncoder().encode(secretValue);
  const encrypted_value = b64encode(cryptoBoxSeal(messageBytes, recipientPk));
  const putRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`,
    {
      method: 'PUT',
      headers: ghHeaders(token),
      body: JSON.stringify({ encrypted_value, key_id }),
    }
  );
  if (!putRes.ok && putRes.status !== 201 && putRes.status !== 204) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error('Set secret ' + secretName + ' fail: ' + (err.message || putRes.status));
  }
}

export default {
  // Cron Trigger: tự động xoá máy hết hạn (chạy mỗi 30 phút)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredMachines(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const isAdminSubdomain = hostname.startsWith('admin.');
    const isShopSubdomain = hostname.startsWith('shop.');

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/assets/community-art.webp') {
      return new Response(COMMUNITY_ART, {
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'public, max-age=604800, immutable',
        },
      });
    }

    // R2 file proxy: /r2/<key> -> TOKENS_R2
    if (url.pathname.startsWith('/r2/')) {
      const key = url.pathname.slice('/r2/'.length);
      if (!key || !isPublicMediaKey(key)) return new Response('Not found', { status: 404 });
      const obj = await env.TOKENS_R2.get(key).catch(() => null);
      if (!obj) return new Response('Not found', { status: 404 });
      const headers = {
        'Content-Type': publicMediaType(key, obj.httpMetadata?.contentType),
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders,
      };
      if (obj.httpEtag) headers.ETag = obj.httpEtag;
      return new Response(obj.body, {
        headers: {
          ...headers,
        },
      });
    }

    // Shop subdomain: API + HTML
    if (isShopSubdomain && url.pathname.startsWith('/api/')) {
      try {
        const apiPath = url.pathname.replace('/api/', '/api/shop/');
        const result = await handleShopAPI(apiPath, request, env);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: err.message === 'Unauthorized' ? 401 : 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }
    if (isShopSubdomain) {
      return new Response(SHOP_HTML, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    if (url.pathname.startsWith('/api/admin/') || (isAdminSubdomain && url.pathname.startsWith('/api/'))) {
      try {
        const apiPath = isAdminSubdomain ? url.pathname.replace('/api/', '/api/admin/') : url.pathname;
        const result = await handleAdminAPI(apiPath, request, env);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: err.message === 'Unauthorized' ? 401 : 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        const result = await handleAPI(url.pathname, request, env);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (url.pathname === '/admin' || isAdminSubdomain) {
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    return new Response(renderConsoleHtml(), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  },
};

function renderConsoleHtml() {
  const bodyStart = HTML_CONTENT.indexOf('<body>') + '<body>'.length;
  const scriptStart = HTML_CONTENT.lastIndexOf('<script>');
  return HTML_CONTENT.slice(0, bodyStart) + CONSOLE_SHELL + HTML_CONTENT.slice(scriptStart);
}

async function handleAPI(path, request, env) {
  if (path === '/api/profile/avatar' && request.method === 'POST') {
    return handleProfileAvatarUpload(request, env);
  }

  const body = request.method === 'POST' ? await request.json() : {};

  // Shop config is a GET endpoint, handle separately
  if (path === '/api/shop-config' && request.method === 'GET') {
    return handleShopConfig(env);
  }

	switch (path) {
	    case '/api/register': return handleRegister(body, env);
	    case '/api/login': return handleLogin(body, env);
	    case '/api/session': return handleSession(body, env);
	    case '/api/profile': return handleUpdateProfile(body, env);
	    case '/api/profile/remove-avatar': return handleRemoveAvatar(body, env);
	    case '/api/change-password': return handleChangePassword(body, env);
	    case '/api/save-token': return handleSaveToken(body, env);
	    case '/api/save-ngrok-token': return handleSaveNgrokToken(body, env);
	    case '/api/fork': return handleFork(body, env);
	    case '/api/run-workflow': return handleRunWorkflow(body, env);
	    case '/api/rdp-info': return handleRdpInfo(body, env);
	    case '/api/delete-machine': return handleDeleteMachine(body, env);
	    case '/api/ping-machine': return handlePingMachine(body, env);
	    case '/api/refresh-machine': return handleRefreshMachine(body, env);
	    case '/api/buy-extension': return handleBuyExtension(body, env);
	    default: throw new Error('Not found');
	  }
}

// ===== Session helpers =====
function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createSession(email, env) {
  const sessionToken = generateSessionToken();
  // Session hết hạn sau 7 ngày
  const user = await env.DB.prepare('SELECT COALESCE(session_version, 0) AS session_version FROM users WHERE email = ?').bind(email).first();
  if (!user) throw new Error('Account not found');
  const principal = JSON.stringify({ email, version: Number(user.session_version) || 0 });
  await env.USERS_KV.put(`session:${sessionToken}`, principal, { expirationTtl: 7 * 24 * 3600 });
  return sessionToken;
}

async function getEmailFromSession(sessionToken, env) {
  if (!sessionToken) throw new Error('Session token required');
  const stored = await env.USERS_KV.get(`session:${sessionToken}`);
  if (!stored) throw new Error('Session expired. Please login again.');

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
    throw new Error('Session expired. Please login again.');
  }
  return email;
}

function defaultUsername(email) {
  return String(email || 'user').split('@')[0].slice(0, 32) || 'user';
}

const ACCOUNT_ROLES = ['user', 'seller', 'admin', 'owner'];
const ADMIN_ACCOUNT_ROLES = ['admin', 'owner'];
const SHOP_ACCOUNT_ROLES = ['seller', 'admin', 'owner'];

function normalizeRole(role) {
  return ACCOUNT_ROLES.includes(role) ? role : 'user';
}

function serializeProfile(user) {
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

function profileFields(profile) {
  return {
    profile,
    username: profile.username,
    avatarUrl: profile.avatarUrl,
    role: profile.role,
  };
}

// ===== D1 User helpers =====
async function getUserData(email, env) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new Error('Account not found');
  return row;
}

async function saveUserField(email, field, value, env) {
  await env.DB.prepare('UPDATE users SET ' + field + ' = ? WHERE email = ?').bind(value, email).run();
}

// ===== D1 Machine helpers =====
async function getUserMachines(email, env) {
  const { results } = await env.DB.prepare('SELECT * FROM machines WHERE user_email = ? ORDER BY created_at DESC').bind(email).all();
  return results || [];
}

async function addMachine(machine, env) {
  await env.DB.prepare(
    'INSERT INTO machines (id, user_email, ngrok_url, username, password, owner, repo, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(machine.id, machine.user_email, machine.ngrok_url, machine.username, machine.password, machine.owner, machine.repo, machine.status || 'active', machine.created_at).run();
}

async function deleteMachineById(id, email, env) {
  await env.DB.prepare('DELETE FROM machines WHERE id = ? AND user_email = ?').bind(id, email).run();
}

async function updateMachineStatus(id, status, env) {
  await env.DB.prepare('UPDATE machines SET status = ? WHERE id = ?').bind(status, id).run();
}

// ===== Cleanup expired machines =====
const MACHINE_TTL_MS = 5 * 60 * 60 * 1000; // 5 giờ

async function cleanupExpiredMachines(env) {
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

// ===== Auth =====
function isValidEmail(e) {
  return typeof e === 'string'
    && e.length >= 5
    && e.length <= 254
    && /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(e);
}

async function handleRegister({ email, password }, env) {
  if (!email || !password) throw new Error('Email and password required');
  if (!isValidEmail(email)) throw new Error('Invalid email format');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  if (password.length > 200) throw new Error('Password too long');

  const existing = await env.DB.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new Error('Email already registered');

	  const hash = await hashPassword(password);
	  const username = defaultUsername(email);
	  await env.DB.prepare(
	    'INSERT INTO users (email, hash, username, created_at) VALUES (?, ?, ?, ?)'
	  ).bind(email, hash, username, Date.now()).run();

	  const sessionToken = await createSession(email, env);
	  const user = await getUserData(email, env);
	  const profile = serializeProfile(user);
	  return { success: true, email, sessionToken, credits: 0, ...profileFields(profile) };
}

// ===== Login rate limit (per email, KV-backed) =====
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_SECONDS = 600; // 10 phút

async function loginAttemptKey(email) { return 'login_attempts:' + email.toLowerCase(); }

async function assertLoginNotLocked(email, env) {
  const key = await loginAttemptKey(email);
  const v = await env.USERS_KV.get(key);
  const n = v ? parseInt(v, 10) : 0;
  if (n >= LOGIN_MAX_ATTEMPTS) {
    throw new Error('Quá nhiều lần đăng nhập sai. Thử lại sau ' + Math.ceil(LOGIN_LOCK_SECONDS / 60) + ' phút.');
  }
}
async function recordFailedLogin(email, env) {
  const key = await loginAttemptKey(email);
  const v = await env.USERS_KV.get(key);
  const n = (v ? parseInt(v, 10) : 0) + 1;
  await env.USERS_KV.put(key, String(n), { expirationTtl: LOGIN_LOCK_SECONDS });
}
async function clearLoginLock(email, env) {
  await env.USERS_KV.delete(await loginAttemptKey(email));
}

async function handleLogin({ email, password }, env) {
  if (!email || !password) throw new Error('Email and password required');
  await assertLoginNotLocked(email, env);

  let user;
  try {
    user = await getUserData(email, env);
  } catch (e) {
    await recordFailedLogin(email, env);
    throw new Error('Invalid credentials');
  }

  const verdict = await verifyPassword(password, user.hash);
  if (!verdict.ok) {
    await recordFailedLogin(email, env);
    throw new Error('Invalid credentials');
  }
  await clearLoginLock(email, env);

  // Migrate legacy / weak hash to current PBKDF2 cost
  if (verdict.needsUpgrade) {
    try {
      const upgraded = await hashPassword(password);
      await saveUserField(email, 'hash', upgraded, env);
    } catch (e) {}
  }

  const machines = await getUserMachines(email, env);
  const sessionToken = await createSession(email, env);
  const profile = serializeProfile(user);
  return {
    success: true, email, sessionToken,
    githubToken: user.github_token || null,
    owner: user.owner || null,
    machines,
    credits: user.credits || 0,
    ...profileFields(profile),
  };
}

// ===== Restore session =====
async function handleSession({ sessionToken }, env) {
  const email = await getEmailFromSession(sessionToken, env);
  const user = await getUserData(email, env);
  const machines = await getUserMachines(email, env);
  const profile = serializeProfile(user);
  return {
    success: true, email,
    githubToken: user.github_token || null,
    owner: user.owner || null,
    machines,
    credits: user.credits || 0,
    ...profileFields(profile),
  };
}

function validateDisplayName(username) {
  if (typeof username !== 'string') throw new Error('Username required');
  const value = username.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (value.length < 2 || value.length > 32) throw new Error('Username must be 2 to 32 characters');
  if (!/^[\p{L}\p{N}._ -]+$/u.test(value)) {
    throw new Error('Username can only contain letters, numbers, spaces, dots, dashes, and underscores');
  }
  return value;
}

async function readRasterUpload(file, maxBytes = 2 * 1024 * 1024) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Image file required');
  if (!file.size || file.size > maxBytes) throw new Error('Image must be smaller than 2 MB');
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
  throw new Error('Only PNG, JPEG, and WebP images are supported');
}

async function handleUpdateProfile({ sessionToken, username }, env) {
  const email = await getEmailFromSession(sessionToken, env);
  const cleanUsername = validateDisplayName(username);
  await env.DB.prepare(
    'UPDATE users SET username = ?, profile_updated_at = ? WHERE email = ?'
  ).bind(cleanUsername, Date.now(), email).run();
  const profile = serializeProfile(await getUserData(email, env));
  return { success: true, ...profileFields(profile) };
}

async function handleProfileAvatarUpload(request, env) {
  const formData = await request.formData();
  const headerToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const sessionToken = String(formData.get('sessionToken') || headerToken || '');
  const email = await getEmailFromSession(sessionToken, env);
  const upload = await readRasterUpload(formData.get('file'));
  const user = await getUserData(email, env);
  const key = `public/avatars/${crypto.randomUUID()}.${upload.ext}`;

  await env.TOKENS_R2.put(key, upload.buffer, {
    httpMetadata: { contentType: upload.contentType },
  });
  try {
    await env.DB.prepare(
      'UPDATE users SET avatar_key = ?, profile_updated_at = ? WHERE email = ?'
    ).bind(key, Date.now(), email).run();
  } catch (error) {
    await env.TOKENS_R2.delete(key).catch(() => {});
    throw error;
  }

  if (user.avatar_key && /^public\/avatars\//.test(user.avatar_key) && user.avatar_key !== key) {
    await env.TOKENS_R2.delete(user.avatar_key).catch(() => {});
  }
  const profile = serializeProfile(await getUserData(email, env));
  return { success: true, ...profileFields(profile) };
}

async function handleRemoveAvatar({ sessionToken }, env) {
  const email = await getEmailFromSession(sessionToken, env);
  const user = await getUserData(email, env);
  await env.DB.prepare(
    'UPDATE users SET avatar_key = NULL, profile_updated_at = ? WHERE email = ?'
  ).bind(Date.now(), email).run();
  if (user.avatar_key && /^public\/avatars\//.test(user.avatar_key)) {
    await env.TOKENS_R2.delete(user.avatar_key).catch(() => {});
  }
  const profile = serializeProfile(await getUserData(email, env));
  return { success: true, ...profileFields(profile) };
}

async function handleChangePassword({ sessionToken, currentPassword, newPassword }, env) {
  if (!currentPassword || !newPassword) throw new Error('Current and new password are required');
  if (newPassword.length < 6) throw new Error('New password must be at least 6 characters');
  if (newPassword.length > 200) throw new Error('New password is too long');
  if (currentPassword === newPassword) throw new Error('New password must be different');

  const email = await getEmailFromSession(sessionToken, env);
  const user = await getUserData(email, env);
  const verdict = await verifyPassword(currentPassword, user.hash);
  if (!verdict.ok) throw new Error('Current password is incorrect');

  const hash = await hashPassword(newPassword);
  await env.DB.prepare(
    'UPDATE users SET hash = ?, session_version = COALESCE(session_version, 0) + 1 WHERE email = ?'
  ).bind(hash, email).run();
  await env.USERS_KV.delete(`session:${sessionToken}`);
  const nextSessionToken = await createSession(email, env);
  const profile = serializeProfile(await getUserData(email, env));
  return { success: true, sessionToken: nextSessionToken, ...profileFields(profile) };
}

// ===== Save GitHub token to user + R2 =====
async function handleSaveToken({ sessionToken, githubToken }, env) {
  if (!githubToken) throw new Error('GitHub token required');
  const email = await getEmailFromSession(sessionToken, env);
  await saveUserField(email, 'github_token', githubToken, env);

  await syncTokensToR2(env);
  return { success: true };
}

async function handleSaveNgrokToken({ sessionToken, ngrokToken }, env) {
  if (!ngrokToken) throw new Error('Ngrok token required');
  const email = await getEmailFromSession(sessionToken, env);
  // Idempotent: tạo column nếu chưa có (D1 không có IF NOT EXISTS cho COLUMN, dùng try)
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN ngrok_token TEXT').run();
  } catch (e) {}
  await saveUserField(email, 'ngrok_token', ngrokToken, env);
  return { success: true };
}

async function getNgrokFastToken(env, fallback) {
  try {
    const stored = await env.USERS_KV.get('config:ngrok_fast_token');
    if (stored) return stored;
  } catch (e) {}
  return fallback;
}

async function getNgrokToken(email, env) {
  try {
    const row = await env.DB.prepare('SELECT ngrok_token FROM users WHERE email = ?').bind(email).first();
    return row && row.ngrok_token;
  } catch (e) {
    return null;
  }
}

async function syncTokensToR2(env) {
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

async function markTokenDead(email, reason, env) {
  try {
    await env.DB.prepare(
      'UPDATE users SET token_status = ?, token_dead_reason = ?, token_dead_at = ? WHERE email = ?'
    ).bind('dead', reason, new Date().toISOString(), email).run();
    await syncTokensToR2(env);
  } catch (e) {}
}

// Gọi /user kiểm tra token còn sống không
async function checkGithubToken(token) {
  try {
    const res = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { alive: true, login: data.login || null, status: res.status };
    }
    const err = await res.json().catch(() => ({}));
    const reason = err.message || ('HTTP ' + res.status);
    return { alive: false, reason, status: res.status, suspended: isSuspended(res.status, err) };
  } catch (e) {
    return { alive: false, reason: e.message || 'network error', status: 0 };
  }
}

// Detect actual account suspension (vs rate-limit / missing scope / etc.)
function isSuspended(status, body) {
  const msg = (body && body.message) ? body.message.toLowerCase() : '';
  if (msg.includes('rate limit') || msg.includes('abuse detection') || msg.includes('secondary rate')) return false;
  if (status === 401 && msg.includes('bad credentials')) return true;
  if (status === 403 && (
    msg.includes('account was suspended')
    || msg.includes('account has been suspended')
    || msg.includes('account has been flagged')
    || msg.includes('account has been disabled')
    || (msg.includes('suspended') && !msg.includes('rate'))
  )) return true;
  return false;
}

// ============================================================
// Admin Backend — Toàn bộ auth + logic chỉ nằm ở server
// ============================================================

async function handleAdminAPI(path, request, env) {
  const body = request.method === 'POST' ? await request.json() : {};

  // Login không cần session
  if (path === '/api/admin/login') return adminLogin(body, env);

  // Tất cả endpoint khác cần admin session
  const adminEmail = await verifyAdminSession(body.adminToken, env);
  if (!adminEmail) throw new Error('Unauthorized');

		  switch (path) {
		    case '/api/admin/users': return adminGetUsers(env);
		    case '/api/admin/tokens': return adminGetTokens(env);
		    case '/api/admin/machines': return adminGetMachines(env);
		    case '/api/admin/reset-password': return adminResetPassword(body, env);
		    case '/api/admin/delete-user': return adminDeleteUser(body, env);
		    case '/api/admin/revoke-token': return adminRevokeToken(body, env);
		    case '/api/admin/check-tokens': return adminCheckTokens(body, env);
		    case '/api/admin/get-ngrok-fast-token': return adminGetNgrokFastToken(env);
		    case '/api/admin/set-ngrok-fast-token': return adminSetNgrokFastToken(body, env);
		    case '/api/admin/add-credits': return adminAddCredits(body, env);
		    case '/api/admin/credits-log': return adminCreditsLog(body, env);
		    case '/api/admin/set-role': return adminSetRole(body, env);
		    default: throw new Error('Not found');
		  }
}

async function adminLogin({ password, email }, env) {
  if (!password) throw new Error('Invalid credentials');
  // Trim trailing newlines (wrangler secret may have trailing \n from echo pipe)
  const cleanPassword = typeof password === 'string' ? password.trim() : password;

  // Rate-limit (key by email if provided, else by 'master')
  const rlEmail = email || '__admin_master__';
  await assertLoginNotLocked(rlEmail, env);

  let authorized = false;
  let principal = { kind: 'master' };

  // Cách 1: ADMIN_PASS secret (master password) — constant-time compare
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
    throw new Error('Invalid credentials');
  }
  await clearLoginLock(rlEmail, env);

  const token = generateSessionToken();
  await env.USERS_KV.put('admin-session:' + token, JSON.stringify(principal), { expirationTtl: 24 * 3600 });
  return { success: true, adminToken: token };
}

async function verifyAdminSession(token, env) {
  if (!token) return null;
  const val = await env.USERS_KV.get('admin-session:' + token);
  if (!val) return null;
  if (val === 'admin') return { kind: 'master' };
  try {
    const principal = JSON.parse(val);
    if (principal.kind === 'master') return principal;
    if (['account', 'admin', 'owner'].includes(principal.kind) && principal.email) {
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

async function adminGetUsers(env) {
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

async function adminGetTokens(env) {
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

async function adminGetMachines(env) {
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

async function adminResetPassword({ email, newPassword }, env) {
  if (!email || !newPassword) throw new Error('Email and new password required');
  if (newPassword.length < 6) throw new Error('Password must be at least 6 characters');
  if (newPassword.length > 200) throw new Error('Password too long');
  const hash = await hashPassword(newPassword);
  await env.DB.prepare(
    'UPDATE users SET hash = ?, session_version = COALESCE(session_version, 0) + 1 WHERE email = ?'
  ).bind(hash, email).run();
  return { success: true, email };
}

async function adminDeleteUser({ email }, env) {
  if (!email) throw new Error('Email required');
  await env.DB.prepare('DELETE FROM machines WHERE user_email = ?').bind(email).run();
  await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
  return { success: true, email };
}

async function adminRevokeToken({ email }, env) {
  if (!email) throw new Error('Email required');
  const user = await getUserData(email, env);
  const oldToken = user.github_token;
  await env.DB.prepare(
    'UPDATE users SET github_token = NULL, token_status = ?, token_dead_reason = NULL, token_dead_at = NULL WHERE email = ?'
  ).bind('active', email).run();
  await syncTokensToR2(env);
  return { success: true, email, revokedToken: oldToken };
}

async function adminGetNgrokFastToken(env) {
  const fallback = MODES.ngrok_fast.presetNgrokToken;
  const value = await getNgrokFastToken(env, fallback);
  const overridden = !!(await env.USERS_KV.get('config:ngrok_fast_token').catch(() => null));
  return { success: true, token: value, overridden, defaultToken: fallback };
}

async function adminSetNgrokFastToken({ token, reset }, env) {
  if (reset) {
    await env.USERS_KV.delete('config:ngrok_fast_token');
    return { success: true, reset: true, token: MODES.ngrok_fast.presetNgrokToken };
  }
  if (!token || typeof token !== 'string' || token.length < 10) {
    throw new Error('Invalid ngrok token');
  }
  await env.USERS_KV.put('config:ngrok_fast_token', token.trim());
  return { success: true, token: token.trim() };
}

async function adminCheckTokens({ emails }, env) {
  let query = 'SELECT email, github_token FROM users WHERE github_token IS NOT NULL';
  let bindings = [];
  if (Array.isArray(emails) && emails.length) {
    const placeholders = emails.map(() => '?').join(',');
    query += ' AND email IN (' + placeholders + ')';
    bindings = emails;
  }
  const stmt = env.DB.prepare(query);
  const { results } = bindings.length ? await stmt.bind(...bindings).all() : await stmt.all();

  const checks = await Promise.all((results || []).map(async (u) => {
    const r = await checkGithubToken(u.github_token);
    return { email: u.email, alive: r.alive, reason: r.reason || null, login: r.login || null, status: r.status };
  }));

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

	// ===== Shop / Credits =====
	async function ensureCreditsColumn(env) {
	  try {
	    await env.DB.prepare('ALTER TABLE users ADD COLUMN credits INTEGER DEFAULT 0').run();
	  } catch (e) {}
	}

	async function handleBuyExtension({ sessionToken, machineId, hours, cost }, env) {
	  if (!sessionToken || !machineId || !hours || !cost) throw new Error('Missing required fields');
	  const email = await getEmailFromSession(sessionToken, env);
	  await ensureCreditsColumn(env);

	  // Check credits
	  const user = await getUserData(email, env);
	  const currentCredits = user.credits || 0;
	  if (currentCredits < cost) throw new Error('Không đủ credits!');

	  // Check machine ownership
	  const machine = await env.DB.prepare(
	    'SELECT * FROM machines WHERE id = ? AND user_email = ?'
	  ).bind(machineId, email).first();
	  if (!machine) throw new Error('Machine not found');

	  // Deduct credits first
	  await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE email = ?').bind(cost, email).run();

	  // Extend machine time (add milliseconds to created_at)
	  const extMs = hours * 60 * 60 * 1000;
	  await env.DB.prepare('UPDATE machines SET created_at = created_at + ? WHERE id = ? AND user_email = ?')
	    .bind(extMs, machineId, email).run();

	  // Return updated machines + credits
	  const machines = await getUserMachines(email, env);
	  const updatedUser = await getUserData(email, env);
	  return {
	    success: true,
	    credits: updatedUser.credits || 0,
	    machines,
		  };
		}

		// ===== Shop config (public GET, reads from KV + R2) =====
		async function handleShopConfig(env) {
		  const [bankName, bankAccount, bankHolder, bannerText] = await Promise.all([
		    env.USERS_KV.get('config:shop_bank_name'),
		    env.USERS_KV.get('config:shop_bank_account'),
		    env.USERS_KV.get('config:shop_bank_holder'),
		    env.USERS_KV.get('config:shop_banner_text'),
		  ]);
		  const logoR2 = await env.TOKENS_R2.get('shop-logo.png').catch(() => null);
		  const qrR2 = await env.TOKENS_R2.get('shop-qr.png').catch(() => null);
		  // Check if R2 file actually exists and is readable
		  let logoUrl = null, qrUrl = null;
		  if (logoR2) {
		    try {
		      const head = await env.TOKENS_R2.head('shop-logo.png');
		      if (head) logoUrl = '/r2/shop-logo.png';
		    } catch(e) {}
		  }
		  if (qrR2) {
		    try {
		      const head = await env.TOKENS_R2.head('shop-qr.png');
		      if (head) qrUrl = '/r2/shop-qr.png';
		    } catch(e) {}
		  }
		  return {
		    success: true,
		    bankName: bankName || '',
		    bankAccount: bankAccount || '',
		    bankHolder: bankHolder || '',
		    bannerText: bannerText || '',
		    logoUrl,
		    qrUrl,
		  };
		}
	
		async function adminAddCredits({ email, amount, adminToken }, env) {
	  if (!email || !amount) throw new Error('Email and amount required');
	  await ensureCreditsColumn(env);
	  const parsed = parseInt(amount, 10);
	  if (isNaN(parsed) || parsed < 0) throw new Error('Invalid amount');
	  await env.DB.prepare('UPDATE users SET credits = COALESCE(credits, 0) + ? WHERE email = ?').bind(parsed, email).run();
	  const user = await getUserData(email, env);
	  return { success: true, email, credits: user.credits || 0 };
	}

		async function adminCreditsLog({ adminToken }, env) {
		  await ensureCreditsColumn(env);
		  const { results } = await env.DB.prepare(
		    'SELECT email, credits FROM users WHERE credits > 0 ORDER BY credits DESC'
		  ).all();
		  return { success: true, entries: results || [] };
		}

			async function adminSetRole({ email, role }, env) {
			  if (!email || !role) throw new Error('Email and role required');
			  if (!ACCOUNT_ROLES.includes(role)) throw new Error('Invalid role. Must be: ' + ACCOUNT_ROLES.join(', '));
			  await env.DB.prepare('UPDATE users SET role = ? WHERE email = ?').bind(role, email).run();
			  return { success: true, email, role };
			}

			// ============================================================
			// Shop Backend — dành cho seller (shop.trueteamcommunity.dpdns.org)
			// ============================================================
			async function handleShopAPI(path, request, env) {
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
			    case '/api/shop/save-bank-info': return saveShopBankInfo(body, env);
			    case '/api/shop/upload-logo': return shopUploadFile(request, env, 'shop-logo.png');
			    case '/api/shop/upload-qr': return shopUploadFile(request, env, 'shop-qr.png');
			    case '/api/shop/products': return getShopProducts(env);
			    case '/api/shop/my-products': return getSellerProducts(sellerEmail, env);
			    case '/api/shop/add-product': return addShopProduct(body, sellerEmail, env);
			    case '/api/shop/delete-product': return deleteShopProduct(body, sellerEmail, env);
			    case '/api/shop/upload-product-image': return shopUploadProductImage(request, env);
			    default: throw new Error('Not found');
			  }
			}

			async function shopLogin({ password, email }, env) {
			  if (!email || !password) throw new Error('Email and password required');
			  await assertLoginNotLocked(email, env);
			  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
			  if (!user) {
			    await recordFailedLogin(email, env);
			    throw new Error('Invalid credentials');
			  }
			  if (!SHOP_ACCOUNT_ROLES.includes(user.role)) throw new Error('You are not authorized to manage the shop');

			  const verdict = await verifyPassword(password, user.hash);
			  if (!verdict.ok) {
			    await recordFailedLogin(email, env);
			    throw new Error('Invalid credentials');
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

			async function verifyShopSession(token, env) {
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

			async function getShopConfig(env) {
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

			async function saveShopBankInfo({ bankName, bankAccount, bankHolder, bannerText }, env) {
			  await Promise.all([
			    env.USERS_KV.put('config:shop_bank_name', bankName || ''),
			    env.USERS_KV.put('config:shop_bank_account', bankAccount || ''),
			    env.USERS_KV.put('config:shop_bank_holder', bankHolder || ''),
			    env.USERS_KV.put('config:shop_banner_text', bannerText || ''),
			  ]);
			  return { success: true };
			}

			async function shopUploadFile(request, env, key) {
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
			async function ensureProductsTable(env) {
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

			async function getShopProducts(env) {
			  await ensureProductsTable(env);
			  const { results } = await env.DB.prepare(
			    'SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC'
			  ).all();
			  return { success: true, products: results || [] };
			}

			async function getSellerProducts(sellerEmail, env) {
			  await ensureProductsTable(env);
			  const { results } = await env.DB.prepare(
			    'SELECT * FROM products WHERE seller_email = ? ORDER BY created_at DESC'
			  ).bind(sellerEmail).all();
			  return { success: true, products: results || [] };
			}

			async function addShopProduct({ name, description, price, category, imageUrl }, sellerEmail, env) {
			  if (!name) throw new Error('Product name required');
			  await ensureProductsTable(env);
			  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			  await env.DB.prepare(
			    'INSERT INTO products (id, name, description, price, image_url, category, active, created_at, seller_email) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
			  ).bind(id, name, description || '', price || 0, imageUrl || '', category || 'general', Date.now(), sellerEmail).run();
			  return { success: true, id };
			}

			async function deleteShopProduct({ productId }, sellerEmail, env) {
			  if (!productId) throw new Error('Product ID required');
			  await ensureProductsTable(env);
			  const product = await env.DB.prepare(
			    'SELECT image_url FROM products WHERE id = ? AND seller_email = ?'
			  ).bind(productId, sellerEmail).first();
			  await env.DB.prepare('DELETE FROM products WHERE id = ? AND seller_email = ?').bind(productId, sellerEmail).run();
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

			async function shopUploadProductImage(request, env) {
			  const formData = await request.formData();
			  const upload = await readRasterUpload(formData.get('file'));
			  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			  const key = 'public/products/' + id + '.' + upload.ext;
			  await env.TOKENS_R2.put(key, upload.buffer, {
			    httpMetadata: { contentType: upload.contentType },
			  });
			  return { success: true, url: '/r2/' + key };
			}

			// R2 file proxy (serve shop-logo.png, shop-qr.png from R2)
			// Handled in fetch() for /r2/ paths
	
		// Legacy single-round SHA-256 (kept ONLY for backward-compat verification of old hashes)
async function hashPasswordLegacy(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'free-vps-salt-2024');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

const PBKDF2_ITERS = 100000;

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await pbkdf2(password, salt, PBKDF2_ITERS);
  return 'pbkdf2$' + PBKDF2_ITERS + '$' + bytesToHex(salt) + '$' + bytesToHex(derived);
}

// Constant-time string compare (prevent timing leaks)
function constEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function verifyPassword(password, stored) {
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

async function handleFork({ token, sessionToken, mode }, env) {
  if (!token) throw new Error('GitHub token required');
  const m = MODES[getMode(mode)];
  const repoName = m.repoName;

  // Lấy thông tin user
  const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
  if (!userRes.ok) {
    const err = await userRes.json().catch(() => ({}));
    if (isSuspended(userRes.status, err) && sessionToken) {
      const email = await getEmailFromSession(sessionToken, env);
      await markTokenDead(email, err.message || 'suspended', env);
      throw new Error('Token suspended! Account has been flagged.');
    }
    throw new Error('GitHub user fetch fail: ' + (err.message || userRes.status));
  }
  const userData = await userRes.json();
  const owner = userData.login;

  // Check repo đã tồn tại trên acc user chưa
  const repoCheck = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    headers: ghHeaders(token),
  });

  let html_url, full_name;
  if (repoCheck.ok) {
    // Repo đã có — dùng luôn
    const r = await repoCheck.json();
    html_url = r.html_url;
    full_name = r.full_name;
  } else if (repoCheck.status === 404) {
    // Tạo repo mới (auto-init để có default branch main)
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({
        name: repoName,
        description: 'Free VPS via GitHub Actions (' + getMode(mode) + ' mode)',
        private: false,
        auto_init: true,
      }),
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error('Tạo repo fail: ' + (err.message || createRes.status));
    }
    const r = await createRes.json();
    html_url = r.html_url;
    full_name = r.full_name;
  } else {
    const err = await repoCheck.json().catch(() => ({}));
    throw new Error('Check repo fail: ' + (err.message || repoCheck.status));
  }

  // Lưu owner vào user record (D1)
  if (sessionToken) {
    try {
      const email = await getEmailFromSession(sessionToken, env);
      await saveUserField(email, 'owner', owner, env);
    } catch (e) {}
  }

  return { success: true, full_name, html_url, owner, name: repoName };
}

async function syncWorkflowFromUpstream(token, owner, repoName, branch, mode) {
  const m = MODES[getMode(mode)];

  // Đợi repo provision xong (vừa tạo có thể chưa sẵn)
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, { headers: ghHeaders(token) });
    if (r.ok) break;
    await new Promise(res => setTimeout(res, 2000));
  }

  // Workflow YAML embedded sẵn trong worker (không cần source repo bên ngoài)
  const targetB64 = m.workflowB64;

  // Check file hiện tại trên user repo
  let userSha = null;
  let userContent = null;
  const userRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/.github/workflows/${m.workflowFile}?ref=${branch}`,
    { headers: ghHeaders(token) }
  );
  if (userRes.ok) {
    const userData = await userRes.json();
    userSha = userData.sha;
    userContent = (userData.content || '').replace(/\s/g, '');
  }

  // Skip nếu nội dung đã match
  const targetClean = targetB64.replace(/\s/g, '');
  if (userContent === targetClean) return { synced: false, reason: 'same' };

  // PUT — tạo commit mới (file mới hoặc update)
  const body = {
    message: 'sync: install/update VPS workflow',
    content: targetClean,
    branch,
  };
  if (userSha) body.sha = userSha;

  const putRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/.github/workflows/${m.workflowFile}`,
    {
      method: 'PUT',
      headers: ghHeaders(token),
      body: JSON.stringify(body),
    }
  );
  if (!putRes.ok && putRes.status !== 201) {
    const err = await putRes.json().catch(() => ({}));
    const msg = err.message || ('HTTP ' + putRes.status);
    // GitHub disguise lỗi quyền ghi workflow file thành 404 "Not Found".
    if (putRes.status === 404 || (/workflow/i.test(msg) && /scope|permission/i.test(msg))) {
      throw new Error('PAT thiếu scope "workflow"! Vào https://github.com/settings/tokens/new tạo PAT classic mới với CẢ 2 scope: ✓repo  ✓workflow. Sau đó vào app dán token mới ở Step 2 rồi deploy lại.');
    }
    throw new Error('Sync workflow file fail: ' + msg);
  }
  return { synced: true };
}

async function handleRunWorkflow({ token, owner, repo, sessionToken, mode }, env) {
  if (!token || !owner) throw new Error('Token and owner required');
  const m = MODES[getMode(mode)];
  const repoName = repo || m.repoName;

  // 0. Lấy default branch
  const repoRes0 = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    headers: ghHeaders(token),
  });
  if (!repoRes0.ok) {
    if (isSuspended(repoRes0.status, await repoRes0.json().catch(() => ({}))) && sessionToken) {
      const email = await getEmailFromSession(sessionToken, env);
      await markTokenDead(email, 'suspended', env);
      throw new Error('Token suspended! Account has been flagged.');
    }
    throw new Error('Repo không truy cập được: HTTP ' + repoRes0.status);
  }
  const branch0 = (await repoRes0.json()).default_branch || 'main';

  // 0.5. Sync workflow file từ upstream (bắt buộc — fork stale có file cũ không có workflow_dispatch)
  await syncWorkflowFromUpstream(token, owner, repoName, branch0, mode);

  // 1. Bật GitHub Actions trên forked repo
  await fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/permissions`, {
    method: 'PUT',
    headers: ghHeaders(token),
    body: JSON.stringify({ enabled: true, allowed_actions: 'all' }),
  });

  // 1.5. Mode cần ngrok token → set secret NGROK_AUTH_TOKEN trên fork
  if (m.needsNgrokToken && sessionToken) {
    const email = await getEmailFromSession(sessionToken, env);
    const ngrokTok = await getNgrokToken(email, env);
    if (!ngrokTok) {
      throw new Error('Mode "' + getMode(mode) + '" cần Ngrok auth token. Lấy ở https://dashboard.ngrok.com/get-started/your-authtoken rồi dán vào ô Ngrok Token (Step 2).');
    }
    try {
      await setActionsSecret(token, owner, repoName, 'NGROK_AUTH_TOKEN', ngrokTok);
    } catch (e) {
      throw new Error('Set NGROK_AUTH_TOKEN secret fail: ' + e.message + '. Token GitHub có thể thiếu scope "repo" admin.');
    }
  } else if (m.presetNgrokToken) {
    const presetTok = await getNgrokFastToken(env, m.presetNgrokToken);
    try {
      await setActionsSecret(token, owner, repoName, 'NGROK_AUTH_TOKEN', presetTok);
    } catch (e) {
      throw new Error('Set NGROK_AUTH_TOKEN (fast) fail: ' + e.message + '. Token GitHub có thể thiếu scope "repo" admin.');
    }
  }

  // 2. Lấy danh sách workflows
  const wfRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/workflows`, {
    headers: ghHeaders(token),
  });

  if (!wfRes.ok) {
    const wfErr = await wfRes.json().catch(() => ({}));
    if (isSuspended(wfRes.status, wfErr) && sessionToken) {
      const email = await getEmailFromSession(sessionToken, env);
      await markTokenDead(email, wfErr.message || 'suspended', env);
      throw new Error('Token suspended! Account has been flagged.');
    }
    throw new Error('Failed to list workflows');
  }

  const { workflows } = await wfRes.json();
  if (!workflows || workflows.length === 0) throw new Error('No workflows found');

  // Ưu tiên workflow đúng mode (rdp.yml); nếu không có dùng workflow đầu tiên
  const wfRegex = new RegExp(m.workflowFile.replace('.', '\\.') + '$', 'i');
  const workflow = workflows.find(w => wfRegex.test(w.path || '')) || workflows[0];
  const wfFilename = (workflow.path || '').split('/').pop() || m.workflowFile;

  // 3. Enable workflow (fork mặc định disable)
  await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${wfFilename}/enable`,
    { method: 'PUT', headers: ghHeaders(token) }
  );

  // 4. Lấy default branch
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
    headers: ghHeaders(token),
  });
  const repoData = await repoRes.json();
  const branch = repoData.default_branch || 'main';

  // 5. Dispatch — retry nếu GitHub Actions chưa re-parse xong workflow file mới
  let lastErr = '';
  for (let i = 0; i < 8; i++) {
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${wfFilename}/dispatches`,
      {
        method: 'POST',
        headers: ghHeaders(token),
        body: JSON.stringify({ ref: branch }),
      }
    );
    if (dispatchRes.ok || dispatchRes.status === 204) {
      // Xoá output file cũ — parser sẽ 404 cho đến khi run mới ghi nội dung tươi
      // (tránh báo "found" với URL/port chết của phiên cũ)
      try {
        const oldRes = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/contents/${m.outputFile}?ref=${branch}`,
          { headers: ghHeaders(token) }
        );
        if (oldRes.ok) {
          const oldData = await oldRes.json();
          await fetch(
            `https://api.github.com/repos/${owner}/${repoName}/contents/${m.outputFile}`,
            {
              method: 'DELETE',
              headers: ghHeaders(token),
              body: JSON.stringify({
                message: 'reset: clear stale connection info before new run',
                sha: oldData.sha,
                branch,
              }),
            }
          );
        }
      } catch (e) {}
      return { success: true, workflow: workflow.name, branch };
    }
    const err = await dispatchRes.json().catch(() => ({}));
    lastErr = err.message || ('HTTP ' + dispatchRes.status);
    // Lỗi đặc trưng khi GH chưa re-parse: "Workflow does not have 'workflow_dispatch' trigger"
    if (/workflow_dispatch/i.test(lastErr) || dispatchRes.status === 422) {
      await new Promise(res => setTimeout(res, 4000));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error('Dispatch failed sau 8 lần thử: ' + lastErr);
}

async function handleRdpInfo({ token, owner, repo, sessionToken, mode }, env) {
  if (!token || !owner) throw new Error('Token and owner required');
  const resolvedMode = getMode(mode);
  const m = MODES[resolvedMode];
  const repoName = repo || m.repoName;

  // Đọc file output của workflow (remote-link.txt cho VNC, rdp_info.txt cho Bore)
  const fileRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${m.outputFile}`,
    {
      headers: {
        ...ghHeaders(token),
        'Cache-Control': 'no-cache',
      },
    }
  );

  if (fileRes.status === 404) {
    throw new Error('Connection info file (' + m.outputFile + ') not found. Workflow may not have started yet.');
  }
  if (!fileRes.ok) {
    throw new Error('Failed to fetch ' + m.outputFile);
  }

  const fileData = await fileRes.json();
  // GitHub trả base64 có thể chứa newline + có thể có BOM (UTF-8 BOM EF BB BF) khi PowerShell ghi
  const raw = atob((fileData.content || '').replace(/\s/g, ''));
  // Bỏ BOM nếu có
  const content = raw.replace(/^\uFEFF/, '').replace(/^\xEF\xBB\xBF/, '').trim();
  const isFailed = /TUNNEL_FAILED|FAILED/i.test(content);

  let info;
  if (resolvedMode === 'bore' || resolvedMode === 'ngrok' || resolvedMode === 'ngrok_fast') {
    // Bore: FULL ADDRESS : bore.pub:12345 hoặc IP/Host: bore.pub + PORT: ...
    // Ngrok: FULL ADDRESS : 0.tcp.ap.ngrok.io:12345
    const addrLine = content.match(/^\s*FULL\s+ADDRESS\s*:\s*(\S+)/im);
    const hostLine = content.match(/^\s*(?:HOST|IP\/Host)\s*:\s*(\S+)/im);
    const portLine = content.match(/^\s*PORT\s*:\s*(\d+)/im);
    const tcpHostMatch = content.match(/(?:bore\.pub|[\w.-]*\.tcp\.[\w-]*\.?ngrok\.io):\d+/i);
    let address = null;
    if (!isFailed) {
      if (addrLine) address = addrLine[1];
      else if (hostLine && portLine) address = hostLine[1] + ':' + portLine[1];
      else if (tcpHostMatch) address = tcpHostMatch[0];
    }
    const userLine = content.match(/^\s*Username\s*:\s*(\S+)/im);
    const passLine = content.match(/^\s*Password\s*:\s*(\S+)/im);
    info = {
      ngrok_url: address,
      username: userLine ? userLine[1] : m.defaultUsername,
      password: passLine ? passLine[1] : m.defaultPassword,
    };
  } else {
    // VNC format: URL : https://... / Password : hieudz
    const urlLine = content.match(/^\s*URL\s*:\s*(\S+)/im);
    const urlAny = content.match(/https?:\/\/[^\s'"<>]+/i);
    const passLine = content.match(/^\s*Password\s*:\s*(\S+)/im);
    info = {
      ngrok_url: isFailed ? null : (urlLine ? urlLine[1] : (urlAny ? urlAny[0] : null)),
      username: m.defaultUsername,
      password: passLine ? passLine[1] : m.defaultPassword,
    };
  }

  // Upsert machine vào D1 (1 row mỗi (user, owner, repo) — port/URL có thể đổi mỗi phiên)
  if (sessionToken && info.ngrok_url) {
    try {
      const email = await getEmailFromSession(sessionToken, env);
      const existing = await env.DB.prepare(
        'SELECT id FROM machines WHERE user_email = ? AND owner = ? AND repo = ?'
      ).bind(email, owner, repoName).first();
      if (existing) {
        await env.DB.prepare(
          'UPDATE machines SET ngrok_url = ?, username = ?, password = ?, status = ? WHERE id = ?'
        ).bind(info.ngrok_url, info.username, info.password, 'active', existing.id).run();
      } else {
        await addMachine({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          user_email: email,
          ngrok_url: info.ngrok_url,
          username: info.username,
          password: info.password,
          owner,
          repo: repoName,
          created_at: Date.now(),
        }, env);
      }
    } catch (e) {}
  }

  return {
    success: true,
    info,
    found: !!info.ngrok_url,
  };
}

async function handleDeleteMachine({ sessionToken, machineId, token }, env) {
  if (!machineId) throw new Error('Machine ID required');
  const email = await getEmailFromSession(sessionToken, env);

  // Lấy machine trước để biết owner/repo cancel workflow
  const machine = await env.DB.prepare(
    'SELECT * FROM machines WHERE id = ? AND user_email = ?'
  ).bind(machineId, email).first();

  if (machine && token) {
    // Disable workflow + cancel mọi run đang chạy/queued (chấp nhận silent fail)
    try {
      const repoName = machine.repo;
      const owner = machine.owner;
      // List active runs
      const runsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/actions/runs?per_page=20`,
        { headers: ghHeaders(token) }
      );
      if (runsRes.ok) {
        const { workflow_runs } = await runsRes.json();
        const active = (workflow_runs || []).filter(r =>
          r.status === 'in_progress' || r.status === 'queued' || r.status === 'pending' || r.status === 'waiting'
        );
          await Promise.all(active.map(r =>
	          fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/runs/${r.id}/cancel`, {
            method: 'POST',
            headers: ghHeaders(token),
          }).catch(() => {})
        ));
      }
      // Disable schedule trigger luôn — không tự khởi động lại sau cron
      const wfRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/actions/workflows`,
        { headers: ghHeaders(token) }
      );
      if (wfRes.ok) {
        const { workflows } = await wfRes.json();
        await Promise.all((workflows || []).map(w =>
          fetch(`https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${w.id}/disable`, {
            method: 'PUT',
            headers: ghHeaders(token),
          }).catch(() => {})
        ));
      }

      // Xoá output file để fetch sau này không trả URL chết
      const repoLow = (repoName || '').toLowerCase();
      const inferredMode = repoLow.includes('ngrok') ? 'ngrok' : repoLow.includes('bore') ? 'bore' : 'vnc';
      // Both ngrok and ngrok_fast use the same outputFile (rdp_info.txt from vps-ngrok repo)
      const outFile = MODES[inferredMode === 'ngrok' ? 'ngrok_fast' : inferredMode]?.outputFile || MODES[inferredMode].outputFile;
      const branch = 'main';
      const oldRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/contents/${outFile}?ref=${branch}`,
        { headers: ghHeaders(token) }
      );
      if (oldRes.ok) {
        const oldData = await oldRes.json();
        await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/contents/${outFile}`,
          {
            method: 'DELETE',
            headers: ghHeaders(token),
            body: JSON.stringify({
              message: 'cleanup: machine deleted',
              sha: oldData.sha,
              branch,
            }),
          }
        ).catch(() => {});
      }
    } catch (e) {}
  }

  await deleteMachineById(machineId, email, env);
  const machines = await getUserMachines(email, env);
  return { success: true, machines };
}

async function handlePingMachine({ token, sessionToken, machineId }, env) {
  if (!token || !machineId) throw new Error('Token and machine ID required');
  const email = await getEmailFromSession(sessionToken, env);
  const machine = await env.DB.prepare(
    'SELECT * FROM machines WHERE id = ? AND user_email = ?'
  ).bind(machineId, email).first();
  if (!machine) throw new Error('Machine not found');

  const owner = machine.owner;
  const repoName = machine.repo || 'vps';

  // Check workflow runs
  const runsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/actions/runs?per_page=5`,
    { headers: ghHeaders(token) }
  );
  if (!runsRes.ok) {
    const runsErr = await runsRes.json().catch(() => ({}));
    if (isSuspended(runsRes.status, runsErr)) {
      await markTokenDead(email, runsErr.message || 'suspended', env);
      throw new Error('Token suspended! Account has been flagged.');
    }
    throw new Error('Failed to fetch runs');
  }
  const { workflow_runs } = await runsRes.json();

  const activeRun = (workflow_runs || []).find(r => r.status === 'in_progress' || r.status === 'queued');

  let urlAlive = false;
  if (machine.ngrok_url) {
    // TCP addresses (bore.pub:12345, 0.tcp.ap.ngrok.io:12345) can't be HTTP-pinged
    const isHttpUrl = /^https?:\/\//i.test(machine.ngrok_url);
    if (isHttpUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(machine.ngrok_url, { signal: controller.signal, redirect: 'manual' });
        clearTimeout(timeout);
        if (r.status > 0) urlAlive = true;
      } catch (e) {}
    } else {
      // For TCP addresses, just check if there's an active run
      urlAlive = !!activeRun;
    }
  }

  const alive = !!activeRun || urlAlive;
  const newStatus = alive ? 'active' : 'dead';
  if (machine.status !== newStatus) {
    await updateMachineStatus(machineId, newStatus, env);
  }

  return {
    success: true,
    alive,
    runStatus: activeRun ? activeRun.status : 'none',
    tcpAlive: urlAlive,
    machineId,
  };
}

async function handleRefreshMachine({ token, sessionToken, machineId }, env) {
  if (!token || !machineId) throw new Error('Token and machine ID required');
  const email = await getEmailFromSession(sessionToken, env);
  const machine = await env.DB.prepare(
    'SELECT * FROM machines WHERE id = ? AND user_email = ?'
  ).bind(machineId, email).first();
  if (!machine) throw new Error('Machine not found');

  // Detect mode từ repo name
  const repoLow = (machine.repo || '').toLowerCase();
  // Both ngrok and ngrok_fast use same workflow/output file
  const inferredMode = repoLow.includes('ngrok') ? 'ngrok' : repoLow.includes('bore') ? 'bore' : 'vnc';
  const data = await handleRdpInfo({
    token, owner: machine.owner, repo: machine.repo, sessionToken, mode: inferredMode,
  }, env);

  const machines = await getUserMachines(email, env);
  return { success: true, info: data.info, found: data.found, machines };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FreeVPSGitHub/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ============================================================
// Frontend HTML
// ============================================================
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<title>TrueTeam Cloud</title>
<meta name="theme-color" content="#0e0c12"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
	<style>
	*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
	:root{
	  --bg:#0e1111;--bg2:#141818;--surface:#1a1e1e;--surface2:#222727;--surface3:#2a3030;
	  --border:rgba(255,255,255,0.08);--border2:rgba(255,255,255,0.12);--border3:rgba(255,255,255,0.18);
	  --text:#ededed;--text2:#a1a1aa;--text3:#71717a;
	  --accent:#3ecf8e;--accent2:#2bbd7e;--accent3:#6ee7b7;--accent-glow:rgba(62,207,142,0.20);
	  --red:#ef4444;--yellow:#eab308;--green:#22c55e;
	  --radius:6px;--radius-lg:8px;
	  --safe-bottom:env(safe-area-inset-bottom,0px);
	  --font-sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
	  --font-mono:'JetBrains Mono','SF Mono',Consolas,monospace;
	  --banner-h:36px;
	}
	html{scroll-behavior:smooth}
	body{
	  font-family:var(--font-sans);
	  background:var(--bg);color:var(--text);
	  min-height:100vh;min-height:100dvh;
	  -webkit-font-smoothing:antialiased;
	  -moz-osx-font-smoothing:grayscale;
	  background-attachment:fixed;
	  letter-spacing:-0.01em;
	}
/* -- Banner Marquee -- */
.banner{
  position:fixed;top:0;left:0;right:0;z-index:101;
  height:var(--banner-h);overflow:hidden;
  background:linear-gradient(90deg,#1a3a2a,var(--accent2),#1a3a2a,var(--accent2),#1a3a2a);
  display:flex;align-items:center;
  cursor:pointer;user-select:none;
}
.banner .banner-close{
  position:absolute;right:8px;top:50%;transform:translateY(-50%);
  z-index:2;background:rgba(0,0,0,0.3);border:none;
  color:#fff;width:22px;height:22px;border-radius:var(--radius);
  font-size:11px;line-height:1;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
}
.banner .banner-close:hover{background:rgba(0,0,0,0.5);}
	.banner-track{
	  display:inline-flex;white-space:nowrap;
	  animation:bannerMarquee 30s linear infinite;
	}
	.banner:hover .banner-track{animation-play-state:paused;}
	.banner-track span{
	  display:inline-block;padding:0 50px;
	  font-size:0.75rem;font-weight:600;color:#fff;
	  letter-spacing:0.02em;
	}
	@keyframes bannerMarquee{
	  0%{transform:translateX(0)}
	  100%{transform:translateX(-50%)}
	}
	body.banner-visible{padding-top:var(--banner-h)}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--border2)}
.app{
  max-width:560px;margin:0 auto;
  padding:20px 20px calc(20px + var(--safe-bottom));
  min-height:100vh;min-height:100dvh;
}
.app.has-machines{max-width:1000px;}
.main-grid{display:flex;flex-direction:column;transition:all 0.4s ease;}
.main-grid.centered{}
@media(min-width:768px){
  .main-grid.split{display:grid;grid-template-columns:460px 1fr;gap:0 24px;align-items:start;}
  .main-grid .col-left,.main-grid .col-right{min-width:0;}
  .main-grid .col-right{animation:slideUp 0.4s ease both;}
}
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.typewriter-cursor{display:inline-block;width:2px;height:14px;background:var(--text2);margin-left:2px;animation:cursorBlink 1s step-end infinite;vertical-align:text-bottom;}
@keyframes cursorBlink{0%,100%{opacity:1}50%{opacity:0}}
/* ---- Header ---- */
.header{text-align:center;padding:32px 0 24px;animation:slideUp 0.5s ease both;}
.header h1{font-size:1.4rem;font-weight:600;color:#fff;letter-spacing:-0.02em;font-family:var(--font-sans);display:flex;align-items:center;justify-content:center;gap:10px;}
.header h1 .logo-mark{
  display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;border-radius:8px;
  background:var(--accent);color:#0e1111;font-size:0.85rem;font-weight:700;
  box-shadow:0 2px 8px var(--accent-glow);
}
.header h1 span{color:var(--accent3);}
.header p{color:var(--text3);font-size:0.8rem;margin-top:6px;font-weight:400;}
/* ---- Divider ---- */
.divider{height:1px;background:var(--border);margin:0 0 20px;}
/* ---- Cards ---- */
.card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:20px;margin-bottom:14px;
  transition:border-color 0.15s ease;
}
.card:hover{border-color:var(--border2);}
.card-title{
  font-size:0.82rem;font-weight:600;margin-bottom:14px;color:var(--text);
  display:flex;align-items:center;gap:8px;
  text-transform:uppercase;letter-spacing:0.02em;
}
/* ---- Steps ---- */
.step{
  width:22px;height:22px;border-radius:var(--radius);
  background:var(--surface2);color:var(--text3);
  display:inline-flex;align-items:center;justify-content:center;
  font-size:0.65rem;font-weight:700;flex-shrink:0;
  font-family:var(--font-mono);
  transition:all 0.2s;
}
.step.done{background:var(--accent);color:#0e1111;box-shadow:0 0 8px var(--accent-glow);}
.step.active{background:transparent;color:var(--accent);border:1.5px solid var(--accent);}
/* ---- Inputs ---- */
.input-group{margin-bottom:14px}
.input-group label{display:block;font-size:0.78rem;font-weight:500;color:var(--text2);margin-bottom:6px;}
.input-group input{
  width:100%;padding:10px 12px;font-size:15px;
  background:var(--surface);border:1px solid var(--border2);
  border-radius:var(--radius);color:var(--text);
  font-family:var(--font-sans);
  outline:none;transition:all 0.15s;
}
.input-group input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);}
.input-group input::placeholder{color:var(--text3);}
/* ---- Buttons ---- */
.btn{
  width:100%;padding:9px 16px;border:1px solid transparent;border-radius:var(--radius);
  font-size:0.82rem;font-weight:500;cursor:pointer;
  font-family:var(--font-sans);
  transition:all 0.12s ease;touch-action:manipulation;
  letter-spacing:-0.005em;
}
.btn:active{transform:scale(0.98);}
.btn-primary{background:var(--accent);color:#0e1111;border-color:var(--accent);font-weight:600;}
.btn-primary:hover{background:var(--accent2);border-color:var(--accent2);box-shadow:0 2px 12px var(--accent-glow);}
.btn-secondary{background:var(--surface2);color:var(--text2);border-color:var(--border2);}
.btn-secondary:hover{background:var(--surface3);color:var(--text);}
.btn-accent{background:var(--accent);color:#0e1111;border-color:var(--accent);font-weight:600;}
.btn-accent:hover{background:var(--accent2);border-color:var(--accent2);box-shadow:0 2px 12px var(--accent-glow);}
.btn:disabled{opacity:0.4;pointer-events:none;}
/* ---- Auth toggle ---- */
.auth-toggle{
  display:flex;gap:0;background:var(--bg);
  padding:3px;border-radius:var(--radius);margin-bottom:18px;
  border:1px solid var(--border);
}
.auth-toggle button{
  flex:1;padding:8px;border:none;border-radius:4px;
  background:transparent;color:var(--text3);cursor:pointer;
  font-weight:500;font-size:0.8rem;transition:all 0.12s;
}
.auth-toggle button.active{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,0.3);}
/* ---- Badges ---- */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:0.65rem;font-weight:600;font-family:var(--font-mono);letter-spacing:0.03em;border:1px solid transparent;white-space:nowrap;}
.badge-green{background:rgba(62,207,142,0.10);color:var(--accent);border-color:rgba(62,207,142,0.20);}
.badge-yellow{background:rgba(234,179,8,0.10);color:var(--yellow);border-color:rgba(234,179,8,0.20);}
.badge-blue{background:rgba(62,207,142,0.06);color:var(--accent3);border-color:rgba(62,207,142,0.12);}
.badge-red{background:rgba(239,68,68,0.10);color:var(--red);border-color:rgba(239,68,68,0.20);}
/* ---- Toast ---- */
.toast-container{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;width:92%;max-width:380px;}
.toast{
  padding:10px 16px;border-radius:var(--radius);margin-bottom:6px;font-size:0.8rem;font-weight:500;
  animation:toastSlide 0.25s ease-out;text-align:center;
  border-left:3px solid var(--accent);
  background:var(--surface);
  box-shadow:0 8px 32px rgba(0,0,0,0.5);
}
.toast-success{border-left-color:var(--accent);}
.toast-error{border-left-color:var(--red);}
@keyframes toastSlide{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
/* ---- Status ---- */
.info-status{
  display:flex;align-items:center;gap:8px;padding:10px 12px;
  border-radius:var(--radius);margin-bottom:12px;font-size:0.8rem;font-weight:500;
  border:1px solid var(--border);background:var(--surface);
}
.info-status.scanning{color:var(--yellow);}
.info-status.ready{color:var(--accent3);}
.info-status.error{color:var(--red);}
.pulse-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 1.5s ease infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
/* ---- Spinner ---- */
.spinner{width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--text);border-radius:50%;animation:spin 0.6s linear infinite;margin:0 auto;}
@keyframes spin{to{transform:rotate(360deg)}}
.hidden{display:none!important}
/* ---- Machine cards ---- */
.machine-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:14px;margin-bottom:10px;
  transition:border-color 0.15s;
}
.machine-card:hover{border-color:var(--border2);}
.machine-card.expired{opacity:0.35;}
.machine-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.machine-id{font-family:var(--font-mono);font-size:0.7rem;color:var(--text3);}
.machine-timer{
  font-family:var(--font-mono);font-size:0.75rem;
  padding:2px 8px;border-radius:4px;font-weight:600;
}
.machine-timer.active{background:rgba(62,207,142,0.08);color:var(--accent3);}
.machine-timer.expired{background:rgba(239,68,68,0.08);color:var(--red);}
.machine-field{
  display:flex;justify-content:space-between;align-items:center;
  padding:8px 10px;background:var(--bg2);border-radius:var(--radius);margin-bottom:4px;
  gap:6px;border:1px solid var(--border);
}
.machine-field > div{min-width:0;flex:1;}
.machine-field-label{font-size:0.62rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.03em;}
.machine-field-value{
  font-family:var(--font-mono);color:var(--text);font-size:0.75rem;
  word-break:break-all;line-height:1.3;
}
.copy-btn{
  padding:4px 10px;background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius);color:var(--text2);cursor:pointer;
  font-size:0.7rem;font-weight:600;white-space:nowrap;flex-shrink:0;
  transition:all 0.12s;
}
.copy-btn:hover{background:var(--surface3);color:var(--text);}
.copy-btn:active{transform:scale(0.95);}
.copy-btn.copied{color:var(--accent3);}
.machine-actions{display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap;}
.machine-status{font-size:0.72rem;display:flex;align-items:center;margin-right:auto;color:var(--text2);}
.status-dot{width:5px;height:5px;border-radius:50%;display:inline-block;margin-right:5px;}
.status-dot.alive{background:var(--accent);}
.status-dot.dead{background:var(--red);}
.status-dot.unknown{background:var(--text3);}
.btn-ping,.btn-delete{
  padding:4px 12px;border-radius:4px;cursor:pointer;
  font-size:0.7rem;font-weight:600;border:1px solid var(--border);transition:all 0.12s;
  background:var(--surface2);
}
.btn-ping{color:var(--text2);}
.btn-ping:hover{color:var(--text);border-color:var(--border2);}
.btn-delete{color:var(--red);}
.btn-delete:hover{background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.2);}
.machines-empty{text-align:center;padding:24px;color:var(--text3);font-size:0.82rem;}
/* ---- Auth success bar ---- */
.auth-bar{
  margin-top:12px;padding:10px 12px;
  background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius);display:flex;justify-content:space-between;align-items:center;gap:8px;
}
.auth-bar-text{font-size:0.78rem;color:var(--text2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.btn-logout{
  padding:4px 12px;background:transparent;border:1px solid var(--border);
  border-radius:var(--radius);color:var(--text3);cursor:pointer;font-size:0.7rem;font-weight:600;
  white-space:nowrap;flex-shrink:0;transition:all 0.12s;
}
.btn-logout:hover{color:var(--red);border-color:rgba(239,68,68,0.3);}
/* ---- Hint box ---- */
.hint-box{
  padding:10px 12px;background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--radius);margin-bottom:14px;font-size:0.78rem;color:var(--text2);line-height:1.5;
}
.hint-box a{color:var(--text);text-decoration:underline;text-underline-offset:2px;font-weight:500;}
.hint-box a:hover{color:var(--accent);}
/* ---- Deploy progress ---- */
.deploy-step{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:0.8rem;color:var(--text2);}
/* ---- Credits / Footer ---- */
.credits{
  text-align:center;padding:14px;margin-bottom:16px;
  border:1px solid var(--border);border-radius:var(--radius-lg);
  font-size:0.72rem;color:var(--text3);line-height:1.7;
  background:var(--surface);
}
.credits strong{color:var(--text2);font-weight:600;}
.credits a{color:var(--text2);text-decoration:none;}
.credits a:hover{color:var(--accent);text-decoration:underline;}
.credits .credits-links{margin-top:6px;display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;}
.credits .credits-links a{
  display:inline-flex;align-items:center;gap:3px;
  padding:4px 10px;border-radius:var(--radius);font-size:0.68rem;
  transition:all 0.12s;border:1px solid var(--border);color:var(--text3);
}
.credits .credits-links a:hover{border-color:var(--border2);color:var(--text);background:var(--surface2);}
.credits .version-tag{
  display:inline-block;margin-top:8px;
  padding:3px 10px;border-radius:9999px;font-size:0.6rem;font-weight:600;
  background:rgba(62,207,142,0.08);color:var(--accent);border:1px solid rgba(62,207,142,0.15);
  font-family:var(--font-mono);letter-spacing:0.03em;
}
/* ---- Notification bell ---- */
.notif-bell{
  position:fixed;top:12px;right:12px;z-index:90;
  width:32px;height:32px;border-radius:var(--radius);
  background:var(--surface);border:1px solid var(--border);
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;font-size:0.9rem;transition:all 0.12s;
}
.notif-bell:hover{border-color:var(--border2);}
.notif-bell:active{transform:scale(0.95);}
.notif-bell .notif-count{
  position:absolute;top:-2px;right:-2px;
  min-width:14px;height:14px;border-radius:9999px;
  background:var(--accent);color:#0e1111;font-size:0.5rem;font-weight:700;
  display:flex;align-items:center;justify-content:center;padding:0 3px;
}
.notif-panel{
  position:fixed;top:50px;right:12px;z-index:91;
  width:300px;max-width:calc(100vw - 24px);max-height:360px;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);
  overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.6);
}
.notif-header{
  padding:12px 14px;border-bottom:1px solid var(--border);
  display:flex;justify-content:space-between;align-items:center;
  font-size:0.8rem;font-weight:600;
}
.notif-clear{font-size:0.7rem;color:var(--text3);cursor:pointer;background:none;border:none;font-weight:500;}
.notif-clear:hover{color:var(--red);}
.notif-item{
  padding:10px 14px;border-bottom:1px solid var(--border);
  font-size:0.76rem;line-height:1.4;transition:background 0.1s;color:var(--text2);
}
.notif-item:hover{background:var(--surface2);}
.notif-item:last-child{border-bottom:none;}
.notif-item .notif-time{font-size:0.62rem;color:var(--text3);margin-top:3px;}
.notif-item.unread{background:rgba(255,255,255,0.02);}
.notif-empty{padding:24px;text-align:center;color:var(--text3);font-size:0.8rem;}
.notif-icon{margin-right:5px;}
.notif-mention{color:var(--text);font-weight:600;}
/* ---- Mode selection cards ---- */
.mode-radio{flex:1 1 0;min-width:135px;cursor:pointer;display:flex;}
.mode-card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:12px;transition:all 0.15s ease;
  display:flex;flex-direction:column;justify-content:center;
  width:100%;min-height:62px;
}
.mode-card.active{
  border-color:var(--accent);
  background:rgba(62,207,142,0.04);
  box-shadow:0 0 0 1px var(--accent);
}
.mode-card:hover{border-color:var(--border2);}
.mode-title{font-weight:600;font-size:0.82rem;color:var(--text);margin-bottom:2px;}
.mode-desc{font-size:0.66rem;color:var(--text3);line-height:1.3;}
/* ---- Shop / Credits Card ---- */
.shop-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px;}
.shop-item{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:12px;text-align:center;
  cursor:pointer;transition:all 0.12s;
}
.shop-item:hover{border-color:var(--accent);}
.shop-item.selected{border-color:var(--accent);background:rgba(62,207,142,0.04);}
.shop-item-hours{font-size:1rem;font-weight:700;color:var(--text);}
.shop-item-cost{font-size:0.7rem;color:var(--text3);margin-top:2px;}
.shop-item-badge{
  display:inline-block;margin-top:6px;padding:2px 8px;border-radius:9999px;
  font-size:0.6rem;font-weight:700;background:var(--accent);color:#0e1111;
}
.credits-display{
  display:flex;align-items:center;justify-content:space-between;
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:10px 12px;margin-bottom:14px;
}
.credits-display .credits-label{font-size:0.78rem;color:var(--text2);}
.credits-display .credits-amount{font-size:1.1rem;font-weight:700;color:var(--accent);font-family:var(--font-mono);}

/* ============================================================
   TrueTeam Cloud Console v6
   ============================================================ */
:root{
  --bg:#0e0c12;
  --bg2:#131117;
  --surface:#19171f;
  --surface2:#211e29;
  --surface3:#2a2634;
  --border:#302c3a;
  --border2:#443d50;
  --border3:#5b526a;
  --text:#f5f2fa;
  --text2:#b6afc2;
  --text3:#7f778d;
  --accent:#b895ff;
  --accent2:#9f7aef;
  --accent3:#dccfff;
  --accent-glow:rgba(184,149,255,0.17);
  --cyan:#75d5ff;
  --amber:#f0c674;
  --coral:#ff8981;
  --red:#ff6b6b;
  --yellow:#f0c674;
  --green:#b895ff;
  --radius:6px;
  --radius-lg:8px;
  --sidebar-w:248px;
  --banner-h:34px;
  --font-sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-mono:'JetBrains Mono','SFMono-Regular',Consolas,monospace;
}
html{background:var(--bg);scroll-padding-top:92px;}
body{
  background:var(--bg);
  color:var(--text);
  letter-spacing:0;
  overflow-x:hidden;
}
body.banner-visible{padding-top:0;}
button,input{letter-spacing:0;}
button:focus-visible,a:focus-visible,input:focus-visible{
  outline:2px solid var(--accent);
  outline-offset:2px;
}
::selection{background:var(--accent);color:#1d122c;}

.icon{width:17px;height:17px;stroke-width:1.8;display:block;flex:0 0 auto;}
.icon-lg{width:20px;height:20px;}
.icon-sm{width:14px;height:14px;}

/* Announcement */
.banner{
  position:fixed;
  inset:0 0 auto 0;
  z-index:200;
  height:var(--banner-h);
  padding:0 44px 0 calc(var(--sidebar-w) + 24px);
  background:#e8ddff;
  border-bottom:1px solid #c9b4f5;
  color:#241b33;
  cursor:pointer;
  display:flex;
  justify-content:center;
}
.banner-track{
  width:100%;
  display:flex;
  align-items:center;
  justify-content:center;
  animation:none;
  overflow:hidden;
}
.banner:hover .banner-track{animation-play-state:running;}
.banner-track span{
  display:block;
  max-width:100%;
  padding:0;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:#241b33;
  font-size:0.72rem;
  font-weight:700;
  letter-spacing:0;
}
.banner-track span:nth-child(n+2){display:none;}
.banner .banner-close{
  right:12px;
  width:24px;
  height:24px;
  color:#3b2852;
  background:transparent;
  border:1px solid rgba(72,48,100,0.22);
}
.banner .banner-close:hover{background:rgba(72,48,100,0.1);}
body.banner-visible .cloud-shell{padding-top:var(--banner-h);}

/* App shell */
.app{
  max-width:none;
  min-height:100vh;
  min-height:100dvh;
  margin:0;
  padding:0;
}
.app.has-machines{max-width:none;}
.cloud-shell{
  min-height:100vh;
  min-height:100dvh;
  display:grid;
  grid-template-columns:var(--sidebar-w) minmax(0,1fr);
}
.console-sidebar{
  position:sticky;
  top:0;
  height:100vh;
  height:100dvh;
  padding:22px 14px 16px;
  background:#121015;
  border-right:1px solid var(--border);
  display:flex;
  flex-direction:column;
  gap:22px;
  z-index:80;
}
body.banner-visible .console-sidebar{
  top:var(--banner-h);
  height:calc(100dvh - var(--banner-h));
}
.brand{
  display:flex;
  align-items:center;
  gap:11px;
  min-height:36px;
  padding:0 8px;
  color:var(--text);
  text-decoration:none;
}
.brand-mark{
  width:32px;
  height:32px;
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:3px;
  padding:6px;
  border:1px solid #5b4973;
  background:#211a2c;
  border-radius:6px;
}
.brand-mark span{display:block;background:var(--accent);border-radius:1px;}
.brand-mark span:nth-child(2),.brand-mark span:nth-child(3){opacity:0.45;}
.brand-copy{min-width:0;display:flex;flex-direction:column;gap:2px;}
.brand-copy strong{font-size:0.83rem;font-weight:700;line-height:1.15;}
.brand-copy small{font-family:var(--font-mono);font-size:0.58rem;color:var(--text3);text-transform:uppercase;}
.sidebar-section-label{
  padding:0 10px;
  margin-bottom:6px;
  font-family:var(--font-mono);
  font-size:0.58rem;
  font-weight:600;
  color:var(--text3);
  text-transform:uppercase;
}
.sidebar-nav{display:flex;flex-direction:column;gap:3px;}
.nav-item{
  width:100%;
  min-height:40px;
  padding:0 10px;
  border:1px solid transparent;
  border-radius:6px;
  background:transparent;
  color:var(--text2);
  display:flex;
  align-items:center;
  gap:10px;
  font:500 0.78rem var(--font-sans);
  text-decoration:none;
  cursor:pointer;
  transition:background 0.14s,border-color 0.14s,color 0.14s;
}
.nav-item:hover{background:var(--surface);border-color:var(--border);color:var(--text);}
.nav-item.active{background:#251d31;border-color:#5a4672;color:var(--accent3);}
.nav-item .nav-meta{margin-left:auto;font:500 0.58rem var(--font-mono);color:var(--text3);}
.sidebar-spacer{flex:1;}
.community-card{
  position:relative;
  overflow:hidden;
  min-height:150px;
  border:1px solid var(--border);
  border-radius:8px;
  background:var(--surface);
}
.community-card img{
  width:100%;
  height:72px;
  object-fit:cover;
  object-position:center 30%;
  display:block;
  opacity:0.82;
}
.community-card__body{padding:11px;}
.community-card__body strong{display:block;font-size:0.73rem;margin-bottom:4px;}
.community-card__body p{font-size:0.65rem;color:var(--text3);line-height:1.45;margin-bottom:9px;}
.community-link{
  width:100%;
  min-height:30px;
  border:1px solid var(--border2);
  border-radius:5px;
  color:var(--text2);
  background:var(--surface2);
  display:flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  font-size:0.67rem;
  font-weight:600;
  text-decoration:none;
}
.community-link:hover{color:var(--text);border-color:var(--accent);}
.local-state{
  display:flex;
  align-items:center;
  gap:7px;
  padding:0 8px;
  color:var(--text3);
  font:500 0.62rem var(--font-mono);
}
.local-state::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);}

/* Workspace */
.workspace{min-width:0;min-height:100dvh;}
.topbar{
  position:sticky;
  top:0;
  z-index:70;
  height:64px;
  padding:0 28px;
  border-bottom:1px solid var(--border);
  background:rgba(14,12,18,0.92);
  backdrop-filter:blur(14px);
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:20px;
}
body.banner-visible .topbar{top:var(--banner-h);}
.breadcrumbs{display:flex;align-items:center;gap:8px;color:var(--text3);font-size:0.72rem;min-width:0;}
.breadcrumbs strong{color:var(--text2);font-weight:500;}
.breadcrumbs .slash{color:#51495e;}
.topbar-actions{display:flex;align-items:center;gap:8px;}
.account-pill{
  min-height:36px;
  border:1px solid var(--border);
  border-radius:6px;
  background:var(--surface);
  display:flex;
  align-items:center;
}
.account-pill{padding:0 8px 0 5px;gap:8px;}
.account-avatar{
  width:26px;height:26px;border-radius:5px;
  display:flex;align-items:center;justify-content:center;
  background:#2b2140;color:var(--accent3);font-size:0.63rem;font-weight:700;overflow:hidden;flex:0 0 auto;
}
.account-avatar__image{width:100%;height:100%;object-fit:cover;display:block;}
.account-pill{color:var(--text);font-family:var(--font-sans);cursor:pointer;transition:border-color 0.14s,background 0.14s;}
.account-pill:hover{border-color:var(--border2);background:var(--surface2);}
.account-identity{min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;}
.account-label{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2);font-size:0.68rem;}
.account-role{color:var(--text3);font:600 0.52rem var(--font-mono);text-transform:uppercase;}
.account-role[data-role='seller']{color:var(--cyan);}
.account-role[data-role='admin']{color:var(--accent3);}
.account-role[data-role='owner']{color:var(--amber);}
.account-chevron{color:var(--text3);}
.notif-bell{
  position:relative;top:auto;right:auto;z-index:auto;
  width:36px;height:36px;border-radius:6px;
  background:var(--surface);border:1px solid var(--border);
  color:var(--text2);
}
.notif-bell:hover{border-color:var(--border2);color:var(--text);}
.notif-panel{top:76px;right:28px;width:340px;background:var(--surface);border-color:var(--border2);}
body.banner-visible .notif-panel{top:calc(76px + var(--banner-h));}
.notif-bell .notif-count{background:var(--coral);color:#240c0a;}

.workspace-content{width:100%;max-width:1280px;margin:0 auto;padding:34px 34px 48px;}
.page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px;}
.page-heading__copy{max-width:720px;}
.eyebrow{display:flex;align-items:center;gap:7px;margin-bottom:8px;color:var(--accent3);font:600 0.64rem var(--font-mono);text-transform:uppercase;}
.eyebrow::before{content:'';width:16px;height:1px;background:var(--accent);}
.page-heading h1{font-size:clamp(1.55rem,2vw,2rem);line-height:1.15;font-weight:650;color:var(--text);}
.page-heading p{margin-top:8px;color:var(--text2);font-size:0.82rem;line-height:1.6;}
.environment-badge{
  flex:0 0 auto;min-height:34px;padding:0 10px;border:1px solid #6b4e8f;border-radius:6px;
  display:flex;align-items:center;gap:7px;color:var(--accent3);background:#21182e;
  font:600 0.64rem var(--font-mono);text-transform:uppercase;
}
.environment-badge::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--accent);}

.metrics-strip{
  min-height:76px;
  margin-bottom:18px;
  padding:0 18px;
  border:1px solid var(--border);
  background:#131117;
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
}
.metric{display:flex;align-items:center;gap:11px;padding:14px 18px;border-right:1px solid var(--border);min-width:0;}
.metric:first-child{padding-left:0;}
.metric:last-child{border-right:0;}
.metric-icon{
  width:34px;height:34px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);
  color:var(--text2);display:flex;align-items:center;justify-content:center;flex:0 0 auto;
}
.metric-copy{min-width:0;}
.metric-copy strong{display:block;font-size:0.78rem;font-weight:600;color:var(--text);}
.metric-copy span{display:block;margin-top:3px;font-size:0.65rem;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

.main-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start;}
.main-grid.centered{display:grid;}
.main-grid.split{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,0.8fr);gap:18px;}
.main-grid .col-left,.main-grid .col-right{min-width:0;}
.main-grid .col-right{animation:slideUp 0.3s ease both;}

/* Shared panels */
.card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:8px;
  padding:20px;
  margin-bottom:14px;
  box-shadow:none;
}
.card:hover{border-color:var(--border2);}
.card-title{
  margin-bottom:16px;
  color:var(--text);
  font-size:0.75rem;
  font-weight:650;
  letter-spacing:0;
  text-transform:none;
}
.step{
  width:24px;height:24px;border-radius:5px;background:var(--surface2);border:1px solid var(--border);
  color:var(--text3);font-size:0.62rem;
}
.step.active{background:#251d31;color:var(--accent3);border:1px solid #6b4e8f;}
.step.done{background:var(--accent);color:#1d122c;box-shadow:none;border-color:var(--accent);}
.section-kicker{display:block;margin-bottom:5px;color:var(--text3);font:600 0.58rem var(--font-mono);text-transform:uppercase;}
.section-title{font-size:0.92rem;font-weight:650;line-height:1.3;}
.section-copy{margin-top:5px;color:var(--text3);font-size:0.72rem;line-height:1.5;}

.auth-card{padding:0;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,0.82fr);}
.auth-intro{padding:24px;border-right:1px solid var(--border);display:flex;flex-direction:column;min-width:0;}
.auth-intro h2{max-width:460px;font-size:1.18rem;font-weight:650;line-height:1.35;}
.auth-intro > p{max-width:520px;margin-top:8px;color:var(--text2);font-size:0.76rem;line-height:1.55;}
.auth-visual{position:relative;margin-top:20px;overflow:hidden;border:1px solid var(--border);border-radius:6px;background:var(--bg2);aspect-ratio:16/6;}
.auth-visual img{width:100%;height:100%;display:block;object-fit:cover;object-position:center 29%;opacity:0.86;}
.auth-visual::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,rgba(14,12,18,0.12),rgba(14,12,18,0.5));pointer-events:none;}
.auth-visual figcaption{position:absolute;left:12px;bottom:10px;z-index:1;padding:5px 7px;border:1px solid rgba(255,255,255,0.18);border-radius:4px;background:rgba(14,12,18,0.8);color:#f7f3fc;font:600 0.58rem var(--font-mono);text-transform:uppercase;}
.trust-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px;}
.trust-item{display:flex;align-items:center;gap:7px;color:var(--text3);font-size:0.63rem;min-width:0;}
.trust-item .icon{color:var(--accent3);}
.auth-form-shell{padding:24px;background:#16131b;display:flex;flex-direction:column;justify-content:center;}
.auth-form-shell h3{font-size:0.96rem;font-weight:650;}
.auth-form-shell > p{margin:5px 0 16px;color:var(--text3);font-size:0.7rem;line-height:1.45;}
.auth-toggle{padding:3px;margin-bottom:16px;background:#110f15;border-color:var(--border);}
.auth-toggle button{min-height:34px;color:var(--text3);font-size:0.72rem;}
.auth-toggle button.active{background:var(--surface2);color:var(--text);box-shadow:none;}
.input-group{margin-bottom:13px;}
.input-group label{margin-bottom:6px;color:var(--text2);font-size:0.68rem;}
.input-group input{
  min-height:42px;padding:9px 11px;background:#121015;border-color:var(--border2);border-radius:6px;color:var(--text);font-size:0.82rem;
}
.input-group input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);}
.btn{min-height:40px;padding:9px 14px;border-radius:6px;font-size:0.74rem;}
.btn-primary,.btn-accent{background:var(--accent);border-color:var(--accent);color:#1d122c;font-weight:700;}
.btn-primary:hover,.btn-accent:hover{background:var(--accent2);border-color:var(--accent2);box-shadow:none;}
.btn-secondary{background:var(--surface2);border-color:var(--border2);color:var(--text2);}
.auth-bar{margin:0;padding:12px;background:#211a2a;border-color:#5a4672;}
.auth-card.authenticated{display:block;padding:14px 16px;}
.auth-card.authenticated .auth-intro,.auth-card.authenticated .auth-form-shell > h3,.auth-card.authenticated .auth-form-shell > p,.auth-card.authenticated .auth-toggle,.auth-card.authenticated form{display:none;}
.auth-card.authenticated .auth-form-shell{padding:0;background:transparent;}
.auth-card.authenticated .auth-bar{margin:0;}

.hint-box{background:#141219;border-color:var(--border);color:var(--text2);font-size:0.7rem;}
.hint-box a{color:var(--accent3);}
.badge-blue{background:rgba(117,213,255,0.09);color:var(--cyan);border-color:rgba(117,213,255,0.2);}
.badge-green{background:rgba(184,149,255,0.11);color:var(--accent3);border-color:rgba(184,149,255,0.22);}
.machine-timer.active{background:rgba(184,149,255,0.1);color:var(--accent3);}
/* Deploy modes */
.mode-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}
.mode-radio{min-width:0;display:flex;}
.mode-card{
  position:relative;min-height:88px;padding:12px;background:#141219;border-color:var(--border);border-radius:6px;
  display:grid;grid-template-columns:34px minmax(0,1fr);align-items:center;gap:10px;
}
.mode-card:hover{border-color:var(--border2);background:#18151d;}
.mode-card.active{border-color:#8062ad;background:#21192b;box-shadow:0 0 0 1px #8062ad;}
.mode-icon{width:34px;height:34px;border:1px solid var(--border);border-radius:6px;background:var(--surface2);display:flex;align-items:center;justify-content:center;color:var(--text2);}
.mode-card[data-tone='cyan'] .mode-icon{color:var(--cyan);}
.mode-card[data-tone='amber'] .mode-icon{color:var(--amber);}
.mode-card[data-tone='green'] .mode-icon{color:var(--accent3);}
.mode-card[data-tone='coral'] .mode-icon{color:var(--coral);}
.mode-title{display:block;margin:0;font-size:0.75rem;}
.mode-desc{display:block;margin-top:4px;font-size:0.62rem;line-height:1.35;}
.mode-badge{position:absolute;top:8px;right:8px;padding:2px 5px;border-radius:3px;background:#332444;color:var(--accent3);font:600 0.52rem var(--font-mono);text-transform:uppercase;}
.ngrok-box{margin-top:10px;padding:12px;background:#141219;border:1px solid var(--border);border-radius:6px;}
.inline-input{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-top:7px;}
.inline-input input{min-width:0;background:#121015;border:1px solid var(--border2);border-radius:6px;padding:9px 10px;color:var(--text);font-size:0.78rem;}
.deploy-step{padding:6px 0;font-size:0.72rem;}
.badge{border-radius:4px;}

/* Machines */
#machinesCard{position:sticky;top:82px;}
body.banner-visible #machinesCard{top:calc(82px + var(--banner-h));}
.machine-card{padding:14px;background:#141219;border-color:var(--border);}
.machine-field{background:#121015;border-color:var(--border);}
.machine-actions{gap:6px;}
.copy-btn,.btn-ping,.btn-delete{border-radius:5px;}

/* Profile dialog */
.profile-modal{
  position:fixed;inset:0;z-index:500;padding:20px;
  display:flex;align-items:center;justify-content:center;
  background:rgba(8,7,11,0.78);backdrop-filter:blur(8px);
}
.profile-dialog{
  width:min(620px,100%);max-height:calc(100dvh - 40px);overflow-y:auto;
  border:1px solid var(--border2);border-radius:8px;background:var(--surface);
  box-shadow:0 24px 80px rgba(0,0,0,0.5);
}
.profile-dialog__header{padding:20px 20px 16px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--border);}
.profile-dialog__header h2{font-size:1rem;font-weight:650;}
.icon-button{
  width:34px;height:34px;border:1px solid var(--border);border-radius:6px;background:var(--surface2);color:var(--text2);
  display:flex;align-items:center;justify-content:center;cursor:pointer;
}
.icon-button:hover{border-color:var(--border2);color:var(--text);}
.profile-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin:14px 20px 0;padding:4px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;}
.profile-tabs button{min-height:34px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--text3);font:600 0.7rem var(--font-sans);cursor:pointer;}
.profile-tabs button.active{background:var(--surface2);border-color:var(--border);color:var(--text);}
.profile-panel{padding:20px;}
.avatar-editor{display:grid;grid-template-columns:84px minmax(0,1fr);gap:16px;align-items:center;padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid var(--border);}
.profile-avatar-preview{width:84px;height:84px;border:1px solid var(--border2);border-radius:8px;background:#2b2140;color:var(--accent3);display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:1.25rem;font-weight:700;}
.profile-avatar-preview img{width:100%;height:100%;object-fit:cover;display:block;}
.avatar-editor__actions strong{display:block;font-size:0.78rem;}
.avatar-editor__actions p{margin-top:4px;color:var(--text3);font-size:0.66rem;}
.button-row{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;}
.btn-inline{width:auto;min-height:34px;display:inline-flex;align-items:center;justify-content:center;gap:6px;}
.profile-form{display:grid;gap:12px;}
.profile-form .input-group{margin:0;}
.profile-readonly-grid{display:grid;grid-template-columns:minmax(0,1fr) 150px;gap:8px;}
.profile-readonly{min-width:0;padding:10px 11px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);}
.profile-readonly span{display:block;color:var(--text3);font-size:0.58rem;text-transform:uppercase;font-family:var(--font-mono);}
.profile-readonly strong{display:block;margin-top:4px;color:var(--text2);font-size:0.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.role-chip{width:max-content;padding:2px 6px;border:1px solid rgba(184,149,255,0.25);border-radius:4px;background:rgba(184,149,255,0.1);color:var(--accent3)!important;text-transform:uppercase;font-family:var(--font-mono);font-size:0.58rem!important;}
.role-chip[data-role='seller']{border-color:rgba(117,213,255,0.25);background:rgba(117,213,255,0.08);color:var(--cyan)!important;}
.role-chip[data-role='admin']{border-color:rgba(184,149,255,0.42);background:rgba(184,149,255,0.16);color:var(--accent3)!important;}
.role-chip[data-role='owner']{border-color:rgba(240,198,116,0.3);background:rgba(240,198,116,0.09);color:var(--amber)!important;}
.security-copy{margin-bottom:16px;}
.security-copy h3{font-size:0.9rem;font-weight:650;}
.security-copy p{margin-top:5px;color:var(--text3);font-size:0.68rem;line-height:1.5;}
.console-footer{margin-top:22px;padding-top:18px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--text3);font-size:0.62rem;}
.console-footer__links{display:flex;gap:14px;}
.console-footer a{color:var(--text3);text-decoration:none;}
.console-footer a:hover{color:var(--text);}

@media(max-width:1024px){
  :root{--sidebar-w:214px;}
  .workspace-content{padding-left:24px;padding-right:24px;}
  .auth-card{grid-template-columns:minmax(0,1fr) 330px;}
  .trust-list{grid-template-columns:1fr;}
  .auth-visual{aspect-ratio:16/7;}
}
@media(max-width:820px){
  body.banner-visible .cloud-shell{padding-top:var(--banner-h);}
  .banner{padding-left:14px;padding-right:44px;}
  .cloud-shell{display:block;}
  .console-sidebar{
    position:relative;top:0!important;width:100%;height:auto!important;padding:12px 16px;gap:12px;border-right:0;border-bottom:1px solid var(--border);
  }
  .brand{padding:0;}
  .sidebar-section-label,.sidebar-spacer,.community-card,.local-state{display:none;}
  .sidebar-nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;}
  .nav-item{min-height:36px;padding:0 8px;justify-content:center;font-size:0.68rem;}
  .nav-item .nav-meta{display:none;}
  .topbar{top:0!important;height:56px;padding:0 16px;}
  body.banner-visible .topbar{top:var(--banner-h)!important;}
  .breadcrumbs{display:none;}
  .topbar-actions{margin-left:auto;}
  .workspace-content{padding:24px 16px 36px;}
  .page-heading{align-items:flex-start;}
  .auth-card{grid-template-columns:1fr;}
  .auth-intro{border-right:0;border-bottom:1px solid var(--border);}
  .main-grid.split{grid-template-columns:1fr;}
  #machinesCard{position:relative;top:auto!important;}
  .notif-panel{right:16px;top:68px!important;}
}
@media(max-width:560px){
  .banner-track span{font-size:0.64rem;}
  .console-sidebar{padding:10px 12px;}
  .brand-copy small{display:none;}
  .sidebar-nav{overflow-x:auto;grid-template-columns:repeat(3,minmax(96px,1fr));padding-bottom:2px;}
  .nav-item{justify-content:flex-start;}
  .account-chevron{display:none;}
  .account-label{max-width:96px;}
  .account-pill{padding-right:5px;}
  .page-heading{display:block;margin-bottom:18px;}
  .environment-badge{width:max-content;margin-top:12px;}
  .page-heading h1{font-size:1.45rem;}
  .metrics-strip{padding:0;grid-template-columns:1fr;}
  .metric{padding:12px;border-right:0;border-bottom:1px solid var(--border);}
  .metric:first-child{padding-left:12px;}
  .metric:last-child{border-bottom:0;}
  .auth-intro,.auth-form-shell{padding:18px;}
  .auth-visual{aspect-ratio:16/8;}
  .trust-list{display:none;}
  .mode-grid{grid-template-columns:1fr;}
  .mode-card{min-height:76px;}
  .inline-input{grid-template-columns:1fr;}
  .profile-modal{padding:8px;align-items:flex-end;}
  .profile-dialog{max-height:calc(100dvh - 16px);}
  .profile-dialog__header{padding:16px;}
  .profile-tabs{margin-left:16px;margin-right:16px;}
  .profile-panel{padding:16px;}
  .avatar-editor{grid-template-columns:68px minmax(0,1fr);}
  .profile-avatar-preview{width:68px;height:68px;}
  .profile-readonly-grid{grid-template-columns:1fr;}
  .console-footer{align-items:flex-start;flex-direction:column;}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{scroll-behavior:auto!important;animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;}
}
</style>
</head>
<body>
<!-- Banner Marquee -->
<div class="banner" id="adBanner" onclick="onBannerClick()">
  <button class="banner-close" onclick="event.stopPropagation();closeBanner()">✕</button>
  <div class="banner-track" id="bannerTrack">
    <span>🚀 TrueTeam Cloud — Free VPS for Everyone! Join our Discord: discord.gg/CTyUJsMNSr</span>
    <span>🚀 TrueTeam Cloud — Free VPS for Everyone! Join our Discord: discord.gg/CTyUJsMNSr</span>
    <span>🚀 TrueTeam Cloud — Free VPS for Everyone! Join our Discord: discord.gg/CTyUJsMNSr</span>
  </div>
</div>
<div class="toast-container" id="toastContainer"></div>

<div class="notif-bell" onclick="toggleNotifPanel()">
  <span>&#128276;</span>
  <span class="notif-count hidden" id="notifCount">0</span>
</div>
<div class="notif-panel hidden" id="notifPanel">
  <div class="notif-header">
    <span>Notifications</span>
    <button class="notif-clear" onclick="clearNotifs()">Clear all</button>
  </div>
  <div id="notifList"><div class="notif-empty">No notifications</div></div>
</div>

<div class="app">
  <header class="header">
    <h1><span class="logo-mark">T</span>TrueTeam <span>Cloud</span></h1>
    <p>Deploy free VPS instances in minutes</p>
  </header>

  <div class="credits">
    <strong>Built by TrueHieu, DucThang, Sakayori &amp; Motlysuana</strong>
    <div style="margin-top:4px;font-size:0.78rem;color:var(--accent3);">Credit: Hiếu Dz</div>
    <div class="credits-links">
      <a href="https://discord.gg/CTyUJsMNSr" target="_blank">&#127918; Discord</a>
      <a href="https://t.me/MlsnChecker" target="_blank">&#9992; Telegram</a>
    </div>
    <span class="version-tag">v5.1.0 · Supabase UI · Shop</span>
  </div>

  <div class="main-grid centered" id="mainGrid">
    <div class="col-left">
      <div class="card" id="authCard">
        <div class="card-title"><span class="step active" id="step1">1</span>Account</div>
        <div class="auth-toggle">
          <button class="active" onclick="setAuthMode('login')">Sign In</button>
          <button onclick="setAuthMode('register')">Register</button>
        </div>
        <form onsubmit="event.preventDefault();handleAuth();">
        <div class="input-group"><label>Email</label><input type="email" id="emailInput" placeholder="you@example.com" autocomplete="email"/></div>
        <div class="input-group"><label>Password</label><input type="password" id="passwordInput" placeholder="Your password" autocomplete="current-password"/></div>
        <button type="submit" class="btn btn-primary" id="authBtn">Sign In</button>
        </form>
        <div id="authSuccess" class="hidden">
          <div class="auth-bar">
            <span class="auth-bar-text" id="authSuccessText"></span>
            <button class="btn-logout" onclick="logout()">Logout</button>
          </div>
        </div>
      </div>

      <div class="card hidden" id="tokenCard">
        <div class="card-title"><span class="step" id="step2">2</span>GitHub Token</div>
        <div class="hint-box">
          Token needs <strong>repo</strong> + <strong>workflow</strong> scopes.
          <a href="https://github.com/settings/tokens/new" target="_blank">Create token &#8594;</a>
        </div>
        <form onsubmit="event.preventDefault();saveToken();">
        <div class="input-group"><label>Personal Access Token</label><input type="password" id="tokenInput" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off"/></div>
        <button type="submit" class="btn btn-primary" id="saveTokenBtn">Save Token</button>
        </form>
	      </div>

	      <!-- Auth + Tab Navigation -->
	      <div class="card hidden" id="mainTabsCard">
	        <div class="auth-toggle" id="mainTabBar">
	          <button class="active" onclick="switchMainTab('deploy',this)">🚀 Deploy</button>
	          <button onclick="switchMainTab('shop',this)">🛒 Shop</button>
	        </div>
	      </div>

	      <!-- Tab: Deploy VPS -->
	      <div id="tabDeploy">
	      <div class="card hidden" id="deployCard">
	        <div class="card-title"><span class="step" id="step3">3</span>Deploy VPS</div>
        <div style="margin-bottom:12px;">
          <div style="font-size:0.78rem;color:var(--text2);margin-bottom:8px;">Chọn phương thức kết nối:</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <label class="mode-radio" onclick="selectMode('vnc')">
              <input type="radio" name="deployMode" id="modeVnc" value="vnc" checked style="display:none"/>
              <div class="mode-card" id="modeCardVnc">
                <div class="mode-title">🌐 noVNC</div>
                <div class="mode-desc">Mở bằng browser. Pass: hieudz</div>
              </div>
            </label>
            <label class="mode-radio" onclick="selectMode('bore')">
              <input type="radio" name="deployMode" id="modeBore" value="bore" style="display:none"/>
              <div class="mode-card" id="modeCardBore">
                <div class="mode-title">🖥️ Bore RDP</div>
                <div class="mode-desc">mstsc. Pass: WindowsRDP2026@</div>
              </div>
            </label>
            <label class="mode-radio" onclick="selectMode('ngrok_fast')">
              <input type="radio" name="deployMode" id="modeNgrokFast" value="ngrok_fast" style="display:none"/>
              <div class="mode-card" id="modeCardNgrokFast">
                <div class="mode-title">⚡ Ngrok Fast</div>
                <div class="mode-desc">Token shared, no setup. Khuyên dùng.</div>
              </div>
            </label>
            <label class="mode-radio" onclick="selectMode('ngrok')">
              <input type="radio" name="deployMode" id="modeNgrok" value="ngrok" style="display:none"/>
              <div class="mode-card" id="modeCardNgrok">
                <div class="mode-title">🚀 Ngrok Custom</div>
                <div class="mode-desc">Tự nhập Ngrok auth token.</div>
              </div>
            </label>
          </div>
          <div id="ngrokTokenBox" class="hidden" style="margin-top:10px;">
            <label style="font-size:0.78rem;color:var(--text2);">Ngrok auth token (lấy ở <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" style="color:var(--accent3);">dashboard.ngrok.com</a>)</label>
            <div style="display:flex;gap:6px;margin-top:6px;">
              <input type="password" id="ngrokTokenInput" placeholder="2v8...xxxxxx" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:0.82rem;"/>
              <button class="btn-ping" id="saveNgrokBtn" onclick="saveNgrokToken()" style="padding:8px 14px;">Save</button>
            </div>
            <div id="ngrokTokenStatus" style="font-size:0.7rem;color:var(--text3);margin-top:4px;"></div>
          </div>
        </div>
        <button class="btn btn-primary" id="deployBtn" onclick="handleDeploy()">Start Deployment</button>
        <div id="deployProgress" class="hidden" style="margin-top:14px;">
          <div class="deploy-step"><span class="badge badge-blue" id="ds-fork-badge">PENDING</span> Fork repository</div>
          <div class="deploy-step"><span class="badge badge-blue" id="ds-workflow-badge">PENDING</span> Run workflow</div>
        </div>
      </div>

      <div class="card hidden" id="rdpCard">
        <div class="card-title"><span class="step" id="step5">4</span><span id="rdpCardTitle">Fetch noVNC Link</span></div>
        <div class="info-status scanning" id="rdpStatus">
          <div class="pulse-dot"></div>
          <span id="rdpStatusText">Ready to scan...</span>
        </div>
        <button class="btn btn-primary" id="fetchRdpBtn" onclick="fetchRdpInfo()">Fetch Connection Info</button>
        <div id="retryInfo" style="font-size:0.72rem;color:var(--text3);margin-top:6px;"></div>
        <div id="rdpHint" style="font-size:0.72rem;color:var(--text3);margin-top:8px;line-height:1.5;">⚠️ Mật khẩu noVNC mặc định: <strong style="color:var(--accent3)">hieudz</strong></div>
	      </div>
	    </div><!-- end tabDeploy -->

		    <!-- Tab: Shop (quảng cáo + logo + bank info) -->
		    <div id="tabShop" class="hidden">
		      <div class="card">
		        <div class="card-title">🛒 Shop — Quảng cáo &amp; Ủng hộ</div>
		        <div style="text-align:center;margin-bottom:14px;">
		          <div id="shopLogoContainer" class="hidden" style="margin-bottom:12px;">
		            <img id="shopLogoImg" src="" alt="Shop Logo" style="max-width:180px;max-height:80px;border-radius:8px;border:1px solid var(--border);"/>
		          </div>
		          <div id="shopBannerText" style="font-size:0.95rem;font-weight:600;color:var(--text3);line-height:1.6;padding:14px;background:var(--surface2);border-radius:var(--radius);border:1px solid var(--border);">
		            Chưa có nội dung quảng cáo
		          </div>
		        </div>
		        <div id="bankInfoSection" class="hidden" style="margin-bottom:10px;padding:14px;background:var(--surface2);border-radius:var(--radius);border:1px solid var(--border);">
		          <div style="font-size:0.78rem;color:var(--text2);margin-bottom:8px;font-weight:600;">💳 Thông tin chuyển khoản</div>
		          <div id="bankInfoDisplay">
		            <div style="font-size:0.82rem;color:var(--text);margin-bottom:4px;">🏦 <span id="bankNameDisplay">...</span></div>
		            <div style="font-size:0.82rem;color:var(--text);margin-bottom:4px;">🔢 STK: <span id="bankAccountDisplay" style="font-weight:600;color:var(--accent3);">...</span></div>
		            <div style="font-size:0.82rem;color:var(--text);">👤 Chủ TK: <span id="bankHolderDisplay">...</span></div>
		          </div>
		          <div id="qrContainer" class="hidden" style="margin-top:10px;text-align:center;">
		            <img id="qrCodeImg" src="" alt="QR Code" style="max-width:160px;max-height:160px;border-radius:8px;border:1px solid var(--border);"/>
		          </div>
		        </div>
		        <div style="font-size:0.72rem;color:var(--text3);text-align:center;line-height:1.5;">
		          Ủng hộ để duy trì dịch vụ Free VPS cho cộng đồng. ❤️
		        </div>
		      </div>
		    </div><!-- end tabShop -->

	  </div><!-- end col-left -->
      <div class="card hidden" id="machinesCard">
        <div class="card-title" style="margin-bottom:12px;">My Machines</div>
        <div id="machinesList"></div>
      </div>
    </div>
  </div>
</div>

<script>
	const MACHINE_TTL = 5 * 60 * 60 * 1000; // 5 tiếng
	const APP_VERSION = '6.0.0';
	let state = { authMode: 'login', email: '', username: '', avatarUrl: '', role: 'user', token: '', owner: '', repo: 'vps-novnc', sessionToken: '', machines: [], mode: 'vnc', ngrokTokenSaved: false, credits: 0, selectedShopItem: null };

function syncAccountChrome(profile) {
  profile = profile || {};
  var email = profile.email || state.email || '';
  var username = profile.username || state.username || (email ? email.split('@')[0] : 'Guest');
  var avatarUrl = profile.avatarUrl || '';
  var role = profile.role || state.role || 'user';
  var label = document.getElementById('accountLabel');
  var avatar = document.getElementById('accountAvatar');
  var avatarImage = document.getElementById('accountAvatarImage');
  var roleLabel = document.getElementById('accountRole');
  var authCard = document.getElementById('authCard');
  var initials = username ? username.slice(0, 2).toUpperCase() : 'TT';

  state.email = email;
  state.username = username;
  state.avatarUrl = avatarUrl;
  state.role = role;

  if (label) label.textContent = username;
  if (avatar) {
    avatar.textContent = initials;
    avatar.classList.toggle('hidden', !!avatarUrl);
  }
  if (avatarImage) {
    avatarImage.src = avatarUrl || '';
    avatarImage.classList.toggle('hidden', !avatarUrl);
  }
  if (roleLabel) {
    roleLabel.textContent = role;
    roleLabel.dataset.role = role;
  }

  var profileUsername = document.getElementById('profileUsername');
  var profileEmail = document.getElementById('profileEmail');
  var profileRole = document.getElementById('profileRole');
  var profileFallback = document.getElementById('profileAvatarFallback');
  var profileImage = document.getElementById('profileAvatarImage');
  var removeAvatarBtn = document.getElementById('removeAvatarBtn');
  if (profileUsername) profileUsername.value = username === 'Guest' ? '' : username;
  if (profileEmail) profileEmail.textContent = email || '-';
  if (profileRole) {
    profileRole.textContent = role;
    profileRole.dataset.role = role;
  }
  if (profileFallback) {
    profileFallback.textContent = initials;
    profileFallback.classList.toggle('hidden', !!avatarUrl);
  }
  if (profileImage) {
    profileImage.src = avatarUrl || '';
    profileImage.classList.toggle('hidden', !avatarUrl);
  }
  if (removeAvatarBtn) removeAvatarBtn.disabled = !avatarUrl;
  if (authCard) authCard.classList.toggle('authenticated', !!email);
}

function openProfileModal() {
  if (!state.sessionToken) {
    toast('Sign in to edit your profile', 'error');
    return;
  }
  syncAccountChrome(state);
  switchProfileTab('profile', document.getElementById('profileTabButton'));
  document.getElementById('profileModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(function(){ document.getElementById('profileUsername')?.focus(); }, 0);
}

function closeProfileModal() {
  document.getElementById('profileModal')?.classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('passwordForm')?.reset();
}

function switchProfileTab(tab, button) {
  document.querySelectorAll('.profile-tabs button').forEach(function(item){ item.classList.remove('active'); });
  if (button) button.classList.add('active');
  document.getElementById('profileTabPanel')?.classList.toggle('hidden', tab !== 'profile');
  document.getElementById('securityTabPanel')?.classList.toggle('hidden', tab !== 'security');
}

function applyProfileData(data) {
  syncAccountChrome(data.profile || data);
}

async function saveProfile() {
  var button = document.getElementById('saveProfileBtn');
  var username = document.getElementById('profileUsername').value;
  setLoading('saveProfileBtn', true);
  try {
    var data = await api('profile', { sessionToken: state.sessionToken, username: username });
    applyProfileData(data);
    toast('Profile updated');
  } catch (error) {
    toast(error.message, 'error');
  }
  setLoading('saveProfileBtn', false);
}

async function uploadProfileAvatar(file) {
  if (!file) return;
  setLoading('uploadAvatarBtn', true);
  try {
    var formData = new FormData();
    formData.append('sessionToken', state.sessionToken);
    formData.append('file', file);
    var response = await fetch('/api/profile/avatar', { method: 'POST', body: formData });
    var data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Avatar upload failed');
    applyProfileData(data);
    toast('Avatar updated');
  } catch (error) {
    toast(error.message, 'error');
  }
  document.getElementById('profileAvatarFile').value = '';
  setLoading('uploadAvatarBtn', false);
}

async function removeProfileAvatar() {
  setLoading('removeAvatarBtn', true);
  try {
    var data = await api('profile/remove-avatar', { sessionToken: state.sessionToken });
    applyProfileData(data);
    toast('Avatar removed');
  } catch (error) {
    toast(error.message, 'error');
  }
  setLoading('removeAvatarBtn', false);
  syncAccountChrome(state);
}

async function changeProfilePassword() {
  var currentPassword = document.getElementById('currentPassword').value;
  var newPassword = document.getElementById('newPassword').value;
  var confirmation = document.getElementById('confirmNewPassword').value;
  if (newPassword !== confirmation) {
    toast('New passwords do not match', 'error');
    return;
  }
  setLoading('changePasswordBtn', true);
  try {
    var data = await api('change-password', {
      sessionToken: state.sessionToken,
      currentPassword: currentPassword,
      newPassword: newPassword,
    });
    state.sessionToken = data.sessionToken;
    localStorage.setItem('sessionToken', data.sessionToken);
    applyProfileData(data);
    document.getElementById('passwordForm').reset();
    toast('Password updated. Other sessions were signed out.');
  } catch (error) {
    toast(error.message, 'error');
  }
  setLoading('changePasswordBtn', false);
}

document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape' && !document.getElementById('profileModal')?.classList.contains('hidden')) {
    closeProfileModal();
  }
});

function selectMode(m) {
  state.mode = m;
  var modes = [
    { id: 'Vnc',       val: 'vnc' },
    { id: 'Bore',      val: 'bore' },
    { id: 'NgrokFast', val: 'ngrok_fast' },
    { id: 'Ngrok',     val: 'ngrok' },
  ];
  modes.forEach(function(k){
    var rb = document.getElementById('mode'+k.id);
    var card = document.getElementById('modeCard'+k.id);
    if (rb) rb.checked = (m === k.val);
    if (card) card.classList.toggle('active', m === k.val);
  });
  state.repo = (m === 'bore') ? 'vps-bore'
    : (m === 'ngrok' || m === 'ngrok_fast') ? 'vps-ngrok'
    : 'vps-novnc';
  // Chỉ hiện ô nhập token cho ngrok custom
  var box = document.getElementById('ngrokTokenBox');
  if (box) box.classList.toggle('hidden', m !== 'ngrok');
  var title = document.getElementById('rdpCardTitle');
  var hint = document.getElementById('rdpHint');
  if (title && hint) {
    if (m === 'bore') {
      title.textContent = 'Fetch RDP Info';
      hint.innerHTML = '⚠️ User: <strong style="color:var(--accent3)">admin</strong> · Pass: <strong style="color:var(--accent3)">WindowsRDP2026@</strong> · mstsc /v:bore.pub:PORT';
    } else if (m === 'ngrok' || m === 'ngrok_fast') {
      title.textContent = 'Fetch Ngrok Info';
      hint.innerHTML = '⚠️ User: <strong style="color:var(--accent3)">DucthengTechDz</strong> · Pass: <strong style="color:var(--accent3)">W1nd0ws-P4ssw0rd-2025!</strong> · mstsc /v:X.tcp.ap.ngrok.io:PORT';
    } else {
      title.textContent = 'Fetch noVNC Link';
      hint.innerHTML = '⚠️ Mật khẩu noVNC mặc định: <strong style="color:var(--accent3)">hieudz</strong>';
    }
  }
	}
	
	// ===== Banner functions =====
	function closeBanner() {
	  document.getElementById('adBanner').classList.add('hidden');
	  document.body.classList.remove('banner-visible');
	  localStorage.setItem('bannerClosed', '1');
	}
	function onBannerClick() {
	  window.open('https://discord.gg/CTyUJsMNSr', '_blank');
	}
	// Restore banner state
	(function(){
	  if (!localStorage.getItem('bannerClosed')) {
	    document.body.classList.add('banner-visible');
	  } else {
	    document.getElementById('adBanner').classList.add('hidden');
	  }
		})();
		
		// ===== Shop tab =====
		var mainTab = 'deploy';
		function switchMainTab(tab, btn) {
		  mainTab = tab;
		  document.querySelectorAll('#mainTabBar button').forEach(function(b){ b.classList.remove('active'); });
		  if (btn) btn.classList.add('active');
		  document.getElementById('tabDeploy').classList.toggle('hidden', tab !== 'deploy');
		  document.getElementById('tabShop').classList.toggle('hidden', tab !== 'shop');
		  if (tab === 'shop') loadShopConfig();
		}
		async function loadShopConfig() {
		  try {
		    var res = await fetch('/api/shop-config');
		    var data = await res.json();
		    if (data.bannerText) {
		      document.getElementById('shopBannerText').innerHTML = data.bannerText;
		    } else {
		      document.getElementById('shopBannerText').innerHTML = '<span style="color:var(--text3);">Chưa có nội dung quảng cáo</span>';
		    }
		    if (data.bankName && data.bankAccount && data.bankHolder) {
		      document.getElementById('bankNameDisplay').textContent = data.bankName;
		      document.getElementById('bankAccountDisplay').textContent = data.bankAccount;
		      document.getElementById('bankHolderDisplay').textContent = data.bankHolder;
		      document.getElementById('bankInfoSection').classList.remove('hidden');
		    } else {
		      document.getElementById('bankInfoSection').classList.add('hidden');
		    }
		    if (data.logoUrl) {
		      document.getElementById('shopLogoImg').src = data.logoUrl;
		      document.getElementById('shopLogoContainer').classList.remove('hidden');
		    } else {
		      document.getElementById('shopLogoContainer').classList.add('hidden');
		    }
		    if (data.qrUrl) {
		      document.getElementById('qrCodeImg').src = data.qrUrl;
		      document.getElementById('qrContainer').classList.remove('hidden');
		    } else {
		      document.getElementById('qrContainer').classList.add('hidden');
		    }
		  } catch(e) {}
		}
		
		async function saveNgrokToken() {
  var token = document.getElementById('ngrokTokenInput').value.trim();
  if (!token) { toast('Cần token Ngrok','error'); return; }
  var statusEl = document.getElementById('ngrokTokenStatus');
  setLoading('saveNgrokBtn', true);
  try {
    await api('save-ngrok-token', { sessionToken: state.sessionToken, ngrokToken: token });
    state.ngrokTokenSaved = true;
    statusEl.innerHTML = '✅ Đã lưu — sẵn sàng deploy ngrok mode';
    statusEl.style.color = 'var(--accent3)';
    toast('Ngrok token saved');
  } catch (e) {
    statusEl.innerHTML = '❌ ' + e.message;
    statusEl.style.color = 'var(--red)';
    toast(e.message,'error');
  }
  setLoading('saveNgrokBtn', false);
}
let retryCount = 0;
let maxRetries = 90;
let retryTimer = null;
let timerInterval = null;

function switchToSplit() {
  var g = document.getElementById('mainGrid');
  g.classList.remove('centered');
  g.classList.add('split');
  document.querySelector('.app').classList.add('has-machines');
}
function switchToCentered() {
  var g = document.getElementById('mainGrid');
  g.classList.remove('split');
  g.classList.add('centered');
  document.querySelector('.app').classList.remove('has-machines');
}

function typewrite(el, text, speed) {
  speed = speed || 30;
  el.textContent = '';
  var cursor = document.createElement('span');
  cursor.className = 'typewriter-cursor';
  el.appendChild(cursor);
  var i = 0;
  function tick() {
    if (i < text.length) {
      el.insertBefore(document.createTextNode(text[i]), cursor);
      i++;
      setTimeout(tick, speed);
    } else {
      setTimeout(function(){ if(cursor.parentNode) cursor.remove(); }, 1500);
    }
  }
  tick();
}

function logout() {
  localStorage.removeItem('sessionToken');
  location.reload();
}

// ===== Notifications =====
var notifications = JSON.parse(localStorage.getItem('notifs') || '[]');

function getMention() {
  return state.email ? ('@' + state.email.split('@')[0]) : '@user';
}

function addNotif(msg, icon) {
  icon = icon || '&#128276;';
  notifications.unshift({ msg: msg, icon: icon, time: Date.now(), read: false });
  if (notifications.length > 50) notifications = notifications.slice(0, 50);
  localStorage.setItem('notifs', JSON.stringify(notifications));
  renderNotifs();
  // Browser notification (skip on mobile / SW-only platforms)
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    var opts = { body: msg.replace(/<[^>]*>/g, ''), icon: '/favicon.ico' };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(function(reg){
        if (reg && reg.showNotification) {
          reg.showNotification('Free VPS GitHub', opts);
        } else {
          try { new Notification('Free VPS GitHub', opts); } catch(e) {}
        }
      }).catch(function(){
        try { new Notification('Free VPS GitHub', opts); } catch(e) {}
      });
    } else {
      try { new Notification('Free VPS GitHub', opts); } catch(e) {}
    }
  }
}

// ===== Update Check =====
function checkForUpdate() {
  var lastVersion = localStorage.getItem('app_version');
  if (lastVersion && lastVersion !== APP_VERSION) {
    addNotif(getMention() + ' Đã update <b>v' + APP_VERSION + '</b>! ✨ Thêm option <b>Bore RDP</b> (mstsc) bên cạnh noVNC, nút <b>🔄 Refresh</b> port trên mỗi máy, nút <b>Delete</b> giờ tự cancel workflow đang chạy, fix YAML upstream khiến dispatch fail. Reload (Ctrl+R) để dùng.', '&#127881;');
  }
  localStorage.setItem('app_version', APP_VERSION);
}

function renderNotifs() {
  var list = document.getElementById('notifList');
  var countEl = document.getElementById('notifCount');
  var unread = notifications.filter(function(n){ return !n.read; }).length;
  if (unread > 0) {
    countEl.textContent = unread > 9 ? '9+' : unread;
    countEl.classList.remove('hidden');
  } else {
    countEl.classList.add('hidden');
  }
  if (notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }
  list.innerHTML = notifications.map(function(n, i) {
    var ago = formatAgo(Date.now() - n.time);
    var styledMsg = n.msg.replace(/@(\\w+)/g, '<span class="notif-mention">@$1</span>');
    return '<div class="notif-item' + (n.read ? '' : ' unread') + '" onclick="markRead(' + i + ')">'
      + '<span class="notif-icon">' + n.icon + '</span>' + styledMsg
      + '<div class="notif-time">' + ago + '</div></div>';
  }).join('');
}

function formatAgo(ms) {
  if (ms < 0) return 'just now';
  var s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function toggleNotifPanel() {
  var panel = document.getElementById('notifPanel');
  panel.classList.toggle('hidden');
}

function markRead(i) {
  if (notifications[i]) notifications[i].read = true;
  localStorage.setItem('notifs', JSON.stringify(notifications));
  renderNotifs();
}

function clearNotifs() {
  notifications = [];
  localStorage.setItem('notifs', '[]');
  renderNotifs();
  toggleNotifPanel();
}

// Request browser notification permission
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  Notification.requestPermission();
}

renderNotifs();
checkForUpdate();
// Init mode card highlight (default: vnc)
setTimeout(function(){ try { selectMode(state.mode || 'vnc'); } catch(e){} }, 0);

// ===== Machines rendering =====
function renderMachines() {
  const list = document.getElementById('machinesList');
  if (!state.machines || state.machines.length === 0) {
    list.innerHTML = '<div class="machines-empty">No machines yet. Deploy one!</div>';
    hide('machinesCard');
    return;
  }
  show('machinesCard');
  const now = Date.now();
  list.innerHTML = state.machines.map(m => {
    var ca = m.createdAt || m.created_at;
    const elapsed = now - ca;
    const remaining = MACHINE_TTL - elapsed;
    const isExpired = remaining <= 0;
    const display = m.ngrok_url || '';
    const isVnc = /^https?:\\/\\//i.test(display);
    const isBore = !isVnc && /:\\d+$/.test(display);
    const copyBtn = '<button class="copy-btn" onclick="copyText(this.previousElementSibling.querySelector(&quot;.machine-field-value&quot;).textContent,this)">Copy</button>';

    let body;
    if (isBore) {
      const mstsc = 'mstsc /v:' + display;
      body = '<div class="machine-field"><div><div class="machine-field-label">Username</div><div class="machine-field-value">' + (m.username || 'admin') + '</div></div>' + copyBtn + '</div>'
        + '<div class="machine-field"><div><div class="machine-field-label">Password</div><div class="machine-field-value">' + (m.password || 'WindowsRDP2026@') + '</div></div>' + copyBtn + '</div>'
        + '<div class="machine-field"><div><div class="machine-field-label">Address</div><div class="machine-field-value" style="word-break:break-all;">' + display + '</div></div>' + copyBtn + '</div>'
        + '<div class="machine-field"><div><div class="machine-field-label">Quick Connect</div><div class="machine-field-value" style="font-family:JetBrains Mono,monospace;font-size:0.78rem;">' + mstsc + '</div></div>' + copyBtn + '</div>'
        + '<div style="font-size:0.72rem;color:var(--text3);margin:6px 2px 8px;">🖥️ Mở Remote Desktop (mstsc) → dán địa chỉ → đăng nhập <strong style="color:var(--accent3)">admin</strong> / <strong style="color:var(--accent3)">' + (m.password || 'WindowsRDP2026@') + '</strong>.</div>';
    } else {
      body = '<div class="machine-field"><div><div class="machine-field-label">VNC Password</div><div class="machine-field-value">' + (m.password || 'hieudz') + '</div></div>' + copyBtn + '</div>'
        + '<div class="machine-field"><div><div class="machine-field-label">VNC URL</div><div class="machine-field-value" style="word-break:break-all;"><a href="' + display + '" target="_blank" rel="noopener" style="color:var(--accent3);text-decoration:none;">' + display + '</a></div></div>' + copyBtn + '</div>'
        + '<div style="font-size:0.72rem;color:var(--text3);margin:6px 2px 8px;">⚠️ Mở link bằng trình duyệt → nhập mật khẩu <strong style="color:var(--accent3)">' + (m.password || 'hieudz') + '</strong> để vào noVNC.</div>';
    }

    return '<div class="machine-card ' + (isExpired ? 'expired' : '') + '">'
      + '<div class="machine-header">'
      + '<span class="machine-id">#' + m.id + (isBore ? ' · Bore RDP' : isVnc ? ' · noVNC' : '') + '</span>'
      + '<span class="machine-timer ' + (isExpired ? 'expired' : 'active') + '" data-created="' + ca + '">'
      + (isExpired ? 'EXPIRED' : formatTime(remaining))
      + '</span></div>'
      + body
      + '<div class="machine-actions">'
      + '<div class="machine-status" id="ping-status-' + m.id + '"><span class="status-dot ' + (m.status === 'dead' ? 'dead' : m.status === 'active' ? 'alive' : 'unknown') + '"></span>' + (m.status === 'dead' ? 'Offline' : m.status === 'active' ? 'Online' : 'Unknown') + '</div>'
      + '<button class="btn-ping" id="refresh-btn-' + m.id + '" onclick="refreshMachine(&quot;' + m.id + '&quot;)" title="Lấy port/URL mới (Bore đổi port mỗi phiên 5h)">🔄 Refresh</button>'
      + '<button class="btn-ping" id="ping-btn-' + m.id + '" onclick="pingMachine(&quot;' + m.id + '&quot;)">Ping</button>'
      + '<button class="btn-delete" onclick="deleteMachine(&quot;' + m.id + '&quot;)">Delete</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

async function refreshMachine(id) {
  var btn = document.getElementById('refresh-btn-' + id);
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '🔄 ...';
  try {
    var data = await api('refresh-machine', { token: state.token, sessionToken: state.sessionToken, machineId: id });
    if (data.machines) state.machines = data.machines;
    renderMachines();
    if (data.found) {
      toast('Đã cập nhật info mới');
    } else {
      toast('Workflow chưa ghi info — đợi thêm vài phút', 'error');
    }
  } catch (e) {
    toast(e.message || 'Refresh fail', 'error');
  }
  btn = document.getElementById('refresh-btn-' + id);
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
}

function formatTime(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

var notifiedMachines = JSON.parse(localStorage.getItem('notifiedMachines') || '{}');

function startTimers() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const timers = document.querySelectorAll('.machine-timer[data-created]');
    const now = Date.now();
    let needRerender = false;
    timers.forEach(el => {
      const created = parseInt(el.dataset.created);
      const remaining = MACHINE_TTL - (now - created);
      const mid = el.closest('.machine-card') ? el.parentElement.querySelector('.machine-id') : null;
      const machineLabel = mid ? mid.textContent : '';

      if (remaining <= 0) {
        if (!el.classList.contains('expired')) {
          needRerender = true;
          // Notify expired
          if (!notifiedMachines[created + '_expired']) {
            notifiedMachines[created + '_expired'] = true;
            localStorage.setItem('notifiedMachines', JSON.stringify(notifiedMachines));
            addNotif(getMention() + ' Machine ' + machineLabel + ' has <b>expired</b>! Deploy a new one to continue.', '&#9940;');
          }
        }
      } else {
        el.textContent = formatTime(remaining);
        // Notify 1h warning
        if (remaining <= 60 * 60 * 1000 && !notifiedMachines[created + '_1h']) {
          notifiedMachines[created + '_1h'] = true;
          localStorage.setItem('notifiedMachines', JSON.stringify(notifiedMachines));
          addNotif(getMention() + ' Machine ' + machineLabel + ' expires in <b>1 hour</b>!', '&#9888;');
        }
        // Notify 30min warning
        if (remaining <= 30 * 60 * 1000 && !notifiedMachines[created + '_30m']) {
          notifiedMachines[created + '_30m'] = true;
          localStorage.setItem('notifiedMachines', JSON.stringify(notifiedMachines));
          addNotif(getMention() + ' Machine ' + machineLabel + ' expires in <b>30 minutes</b>! Save your work.', '&#9888;');
        }
        // Notify 5min warning
        if (remaining <= 5 * 60 * 1000 && !notifiedMachines[created + '_5m']) {
          notifiedMachines[created + '_5m'] = true;
          localStorage.setItem('notifiedMachines', JSON.stringify(notifiedMachines));
          addNotif(getMention() + ' Machine ' + machineLabel + ' expires in <b>5 minutes</b>! Almost out of time!', '&#128308;');
        }
      }
    });
    if (needRerender) renderMachines();
  }, 1000);
}

async function deleteMachine(id) {
  if (!confirm('Xoá máy + cancel workflow đang chạy + disable schedule trigger?')) return;
  try {
    const data = await api('delete-machine', { sessionToken: state.sessionToken, machineId: id, token: state.token });
    state.machines = data.machines;
    renderMachines();
    toast('Machine deleted + workflow cancelled');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function pingMachine(id) {
  var btn = document.getElementById('ping-btn-' + id);
  var statusEl = document.getElementById('ping-status-' + id);
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '...';
  statusEl.innerHTML = '<span class="status-dot unknown"></span>Checking...';
  try {
    var data = await api('ping-machine', { token: state.token, sessionToken: state.sessionToken, machineId: id });
    if (data.alive) {
      statusEl.innerHTML = '<span class="status-dot alive"></span>Online';
      // Update local state
      var m = state.machines.find(function(x){ return x.id === id; });
      if (m) m.status = 'active';
    } else {
      statusEl.innerHTML = '<span class="status-dot dead"></span>Offline';
      var m2 = state.machines.find(function(x){ return x.id === id; });
      if (m2) m2.status = 'dead';
    }
    toast(data.alive ? 'Machine is online!' : 'Machine is offline');
    if (!data.alive) {
      addNotif(getMention() + ' Machine <b>' + id + '</b> is now <b>offline</b>.', '&#128308;');
    }
  } catch (e) {
    statusEl.innerHTML = '<span class="status-dot dead"></span>Error';
    toast(e.message, 'error');
  }
  btn.disabled = false;
  btn.textContent = 'Ping';
}

// ===== Init: restore session on page load =====
async function restoreSession() {
  const saved = localStorage.getItem('sessionToken');
  if (!saved) return;
  try {
    const data = await api('session', { sessionToken: saved });
		    state.sessionToken = saved;
		    state.email = data.email;
		    state.machines = data.machines || [];
		    state.credits = data.credits || 0;
		    syncAccountChrome(data.profile || data);

		    setStepDone(1);
		    document.getElementById('authSuccess').classList.remove('hidden');
		    typewrite(document.getElementById('authSuccessText'), 'Signed in as ' + data.email);
		    document.getElementById('authBtn').classList.add('hidden');

		    if (data.githubToken) {
		      state.token = data.githubToken;
		      document.getElementById('tokenInput').value = '••••••••••••••••';
		      setStepDone(2);
		      show('tokenCard');
		      show('deployCard');
		      setStepActive(3);
		    } else {
		      show('tokenCard');
		      setStepActive(2);
		    }

		    if (data.owner) state.owner = data.owner;

		    if (state.token) {
		      show('rdpCard');
		      setStepActive(5);
		    }

		    renderMachines();
		    startTimers();
		    if (state.machines && state.machines.length > 0) switchToSplit();
		    toast('Session restored!');
		  } catch (e) {
		    localStorage.removeItem('sessionToken');
		  }
		}
		restoreSession();

function toast(msg, type = 'success') {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  c.appendChild(t);
  typewrite(t, msg, 20);
  setTimeout(() => t.remove(), 4000);
}

	async function api(path, data) {
	  const res = await fetch('/api/' + path, {
	    method: 'POST',
	    headers: { 'Content-Type': 'application/json' },
	    body: JSON.stringify(data),
	  });
	  let json;
	  try {
	    json = await res.json();
	  } catch (e) {
	    const text = await res.text().catch(() => '');
	    throw new Error(text ? 'Server: ' + text.slice(0, 200) : 'HTTP ' + res.status);
	  }
	  if (json.error) throw new Error(json.error);
	  return json;
	}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function setStepDone(n) {
  const el = document.getElementById('step' + n);
  if (el) el.className = 'step done';
}
function setStepActive(n) {
  const el = document.getElementById('step' + n);
  if (el) el.className = 'step active';
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (loading) {
    btn.disabled = true;
    btn._html = btn.innerHTML;
    btn.innerHTML = '<div class="spinner"></div>';
  } else {
    btn.disabled = false;
    btn.innerHTML = btn._html || btn.innerHTML;
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  const btns = document.querySelectorAll('.auth-toggle button');
  btns.forEach(b => b.classList.remove('active'));
  btns[mode === 'login' ? 0 : 1].classList.add('active');
  document.getElementById('authBtn').textContent = mode === 'login' ? 'Sign In' : 'Create Account';
  var title = document.getElementById('authFormTitle');
  var copy = document.getElementById('authFormCopy');
  if (title) title.textContent = mode === 'login' ? 'Sign in to continue' : 'Create your account';
  if (copy) copy.textContent = mode === 'login'
    ? 'Access deployments, machines, and connection details.'
    : 'Set up a protected TrueTeam session in a few seconds.';
}

	async function handleAuth() {
	  const email = document.getElementById('emailInput').value.trim();
	  const password = document.getElementById('passwordInput').value;
	  if (!email || !password) return toast('Please fill in all fields', 'error');
	  setLoading('authBtn', true);
	  try {
		    const data = await api(state.authMode === 'login' ? 'login' : 'register', { email, password });
		    state.email = email;
		    state.sessionToken = data.sessionToken;
		    state.machines = data.machines || [];
		    state.credits = data.credits || 0;
		    localStorage.setItem('sessionToken', data.sessionToken);
		    syncAccountChrome(data.profile || data);

		    setStepDone(1);
		    document.getElementById('authSuccess').classList.remove('hidden');
		    typewrite(document.getElementById('authSuccessText'), 'Signed in as ' + email);
		    document.getElementById('authBtn').classList.add('hidden');

	    if (data.githubToken) {
	      state.token = data.githubToken;
	      document.getElementById('tokenInput').value = '••••••••••••••••';
	      setStepDone(2);
	      show('tokenCard');
	      show('deployCard');
	      setStepActive(3);
      if (data.owner) {
        state.owner = data.owner;
      }
      show('rdpCard');
      setStepActive(5);
    } else {
      show('tokenCard');
      setStepActive(2);
    }

    renderMachines();
    startTimers();
    if (state.machines && state.machines.length > 0) switchToSplit();
    toast('Success!');
    addNotif(getMention() + ' Welcome back! You are now signed in.', '&#128075;');
  } catch (e) {
    toast(e.message, 'error');
  }
  setLoading('authBtn', false);
}

async function saveToken() {
  const token = document.getElementById('tokenInput').value.trim();
  if (!token) return toast('Please enter token', 'error');
  state.token = token;

  if (state.sessionToken) {
    try {
      await api('save-token', { sessionToken: state.sessionToken, githubToken: token });
    } catch (e) { /* silent */ }
  }

  setStepDone(2);
  show('deployCard');
  setStepActive(3);
  toast('Token saved');
}

async function handleDeploy() {
  setLoading('deployBtn', true);
  show('deployProgress');

  document.getElementById('ds-fork-badge').className = 'badge badge-yellow';
  document.getElementById('ds-fork-badge').textContent = 'RUNNING';

  try {
    const fork = await api('fork', { token: state.token, sessionToken: state.sessionToken, mode: state.mode });
    state.owner = fork.owner;
    if (fork.name) state.repo = fork.name;
    document.getElementById('ds-fork-badge').className = 'badge badge-green';
    document.getElementById('ds-fork-badge').textContent = 'DONE';
  } catch (e) {
    if (e.message.includes('already exists')) {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: 'Bearer ' + state.token }
      });
      const userData = await userRes.json();
      state.owner = userData.login;
      state.repo = (state.mode === 'bore') ? 'vps-bore' : (state.mode === 'ngrok' || state.mode === 'ngrok_fast') ? 'vps-ngrok' : 'vps-novnc';
      document.getElementById('ds-fork-badge').className = 'badge badge-green';
      document.getElementById('ds-fork-badge').textContent = 'DONE';
    } else {
      document.getElementById('ds-fork-badge').className = 'badge badge-red';
      document.getElementById('ds-fork-badge').textContent = 'FAIL';
      toast(e.message, 'error');
      setLoading('deployBtn', false);
      return;
    }
  }

  await new Promise(r => setTimeout(r, 3000));

  document.getElementById('ds-workflow-badge').className = 'badge badge-yellow';
  document.getElementById('ds-workflow-badge').textContent = 'RUNNING';

  try {
    await api('run-workflow', { token: state.token, owner: state.owner, repo: state.repo, sessionToken: state.sessionToken, mode: state.mode });
    document.getElementById('ds-workflow-badge').className = 'badge badge-green';
    document.getElementById('ds-workflow-badge').textContent = 'DONE';
    toast('Workflow started!');
  } catch (e) {
    document.getElementById('ds-workflow-badge').className = 'badge badge-red';
    document.getElementById('ds-workflow-badge').textContent = 'FAIL';
    toast(e.message, 'error');
    setLoading('deployBtn', false);
    return;
  }

  setLoading('deployBtn', false);
  setStepDone(3);
  show('rdpCard');
  setStepActive(5);

  var connKindStart = (state.mode === 'bore') ? 'RDP info' : 'noVNC link';
  toast('Deployment started! Auto-fetching ' + connKindStart + '...');
  addNotif(getMention() + ' Deployment started! Waiting for ' + connKindStart + '...', '&#128640;');
  document.getElementById('rdpStatusText').textContent = 'Waiting for workflow...';

  retryCount = 0;
  fetchStartTime = Date.now();
  startEtaTicker();
  setTimeout(() => fetchRdpInfoWithRetry(), 30000);
}

var fetchStartTime = 0;
var etaInterval = null;

function fmtMMSS(s) {
  if (s < 0) s = 0;
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}

function getStageHint(elapsedSec, mode) {
  if (mode === 'bore') {
    if (elapsedSec < 30)  return '🚀 Workflow đang khởi động...';
    if (elapsedSec < 60)  return '⬇️ Tải bore.exe + cài RDP user...';
    if (elapsedSec < 150) return '🔌 Đợi bore.pub assign port...';
    return '⏳ Bore mất hơi lâu, đang đợi...';
  } else if (mode === 'ngrok' || mode === 'ngrok_fast') {
    if (elapsedSec < 30)  return '🚀 Workflow đang khởi động...';
    if (elapsedSec < 60)  return '⬇️ Tải ngrok + cài RDP user...';
    if (elapsedSec < 150) return '🔌 Đợi ngrok cấp tunnel...';
    return '⏳ Ngrok mất hơi lâu, đang đợi...';
  } else {
    if (elapsedSec < 30)  return '🚀 Workflow đang khởi động...';
    if (elapsedSec < 90)  return '⬇️ Cài TightVNC + Python websockify...';
    if (elapsedSec < 180) return '🌐 Tải Cloudflared + bật tunnel...';
    if (elapsedSec < 360) return '🔌 Đợi Cloudflared cấp subdomain...';
    return '⏳ Cloudflared mất hơi lâu, đang đợi...';
  }
}

function startEtaTicker() {
  if (etaInterval) clearInterval(etaInterval);
  etaInterval = setInterval(updateEtaDisplay, 1000);
  updateEtaDisplay();
}

function stopEtaTicker() {
  if (etaInterval) { clearInterval(etaInterval); etaInterval = null; }
}

function updateEtaDisplay() {
  if (!fetchStartTime) return;
  var el = document.getElementById('retryInfo');
  if (!el) return;
  var elapsed = Math.floor((Date.now() - fetchStartTime) / 1000);
  var mode = state.mode;
  var etaTotal = mode === 'bore' ? 180 : (mode === 'ngrok' || mode === 'ngrok_fast') ? 210 : 420;
  var remaining = Math.max(0, etaTotal - elapsed);
  var stage = getStageHint(elapsed, mode);
  el.innerHTML = '<div style="display:flex;justify-content:space-between;gap:8px;font-size:0.72rem;">'
    + '<span>⏱ ' + fmtMMSS(elapsed) + ' đã chờ</span>'
    + '<span style="color:var(--text2);">ETA ~' + fmtMMSS(remaining) + '</span>'
    + '</div>'
    + '<div style="margin-top:4px;font-size:0.72rem;color:var(--text2);">' + stage + '</div>';
}

async function fetchRdpInfo() {
  if (!fetchStartTime) { fetchStartTime = Date.now(); startEtaTicker(); }
  return fetchRdpInfoWithRetry();
}

async function fetchRdpInfoWithRetry() {
  if (retryTimer) clearTimeout(retryTimer);

  var mode = state.mode;
  var isBore = (mode === 'bore');
  var isNgrok = (mode === 'ngrok' || mode === 'ngrok_fast');
  var connKind = isBore ? 'RDP info' : (isNgrok ? 'Ngrok info' : 'noVNC link');

  setLoading('fetchRdpBtn', true);
  document.getElementById('rdpStatus').className = 'info-status scanning';
  document.getElementById('rdpStatusText').textContent = 'Fetching ' + connKind + '... (' + (retryCount + 1) + '/' + maxRetries + ')';
  updateEtaDisplay();

  try {
    const data = await api('rdp-info', { token: state.token, owner: state.owner, repo: state.repo, sessionToken: state.sessionToken, mode: mode });
    const info = data.info;

    if (info.ngrok_url) {
      stopEtaTicker();
      var totalElapsed = fetchStartTime ? Math.floor((Date.now() - fetchStartTime)/1000) : 0;
      fetchStartTime = 0;
      document.getElementById('rdpStatus').className = 'info-status ready';
      var label = isBore ? ('Bore RDP: ' + info.ngrok_url)
        : isNgrok ? ('Ngrok RDP: ' + info.ngrok_url)
        : ('noVNC Link: ' + info.ngrok_url);
      typewrite(document.getElementById('rdpStatusText'), label);
      var hintHtml;
      if (isBore) {
        hintHtml = 'User: <strong style="color:var(--accent3)">' + (info.username || 'admin') + '</strong> · Pass: <strong style="color:var(--accent3)">' + (info.password || 'WindowsRDP2026@') + '</strong> · <code style="color:var(--text2)">mstsc /v:' + info.ngrok_url + '</code>';
      } else if (isNgrok) {
        hintHtml = 'User: <strong style="color:var(--accent3)">' + (info.username || 'DucthengTechDz') + '</strong> · Pass: <strong style="color:var(--accent3)">' + (info.password || 'W1nd0ws-P4ssw0rd-2025!') + '</strong> · <code style="color:var(--text2)">mstsc /v:' + info.ngrok_url + '</code>';
      } else {
        hintHtml = 'Mật khẩu: <strong style="color:var(--accent3)">' + (info.password || 'hieudz') + '</strong>';
      }
      hintHtml += ' · <span style="color:var(--text3)">⏱ ' + fmtMMSS(totalElapsed) + '</span>';
      document.getElementById('retryInfo').innerHTML = hintHtml;
      setStepDone(5);
      setLoading('fetchRdpBtn', false);
      toast(connKind + ' found!');
      var notifHtml;
      if (isBore) {
        notifHtml = ' Your VPS is <b>ready</b>! Bore RDP: <code>mstsc /v:' + info.ngrok_url + '</code> · ' + (info.username || 'admin') + ' / ' + (info.password || 'WindowsRDP2026@');
      } else if (isNgrok) {
        notifHtml = ' Your VPS is <b>ready</b>! Ngrok RDP: <code>mstsc /v:' + info.ngrok_url + '</code> · ' + (info.username || 'DucthengTechDz') + ' / ' + (info.password || 'W1nd0ws-P4ssw0rd-2025!');
      } else {
        notifHtml = ' Your VPS is <b>ready</b>! noVNC link: <a href="' + info.ngrok_url + '" target="_blank">Open</a> (pass: ' + (info.password || 'hieudz') + ')';
      }
      addNotif(getMention() + notifHtml, '&#9989;');

      // Refresh machines từ server
      try {
        const session = await api('session', { sessionToken: state.sessionToken });
        state.machines = session.machines || [];
      } catch (e) {
        // Thêm local nếu ko refresh được
        const exists = state.machines.some(m => m.ngrok_url === info.ngrok_url);
        if (!exists) {
          state.machines.push({ id: Date.now().toString(36), ...info, createdAt: Date.now() });
        }
      }
      renderMachines();
      startTimers();
      switchToSplit();
      return;
    }

    if (retryCount < maxRetries) {
      retryCount++;
      retryTimer = setTimeout(() => fetchRdpInfoWithRetry(), 10000);
      setLoading('fetchRdpBtn', false);
      document.getElementById('fetchRdpBtn').disabled = false;
      document.getElementById('fetchRdpBtn').innerHTML = '🔄 Auto-retrying...';
    } else {
      stopEtaTicker();
      fetchStartTime = 0;
      document.getElementById('rdpStatus').className = 'info-status error';
      document.getElementById('rdpStatusText').textContent = '❌ Timeout';
      document.getElementById('retryInfo').textContent = 'Quá 15 phút chưa có info — workflow có thể fail. Check GitHub Actions tab.';
      setLoading('fetchRdpBtn', false);
    }

  } catch (e) {
    if (retryCount < maxRetries) {
      retryCount++;
      retryTimer = setTimeout(() => fetchRdpInfoWithRetry(), 10000);
      setLoading('fetchRdpBtn', false);
      document.getElementById('fetchRdpBtn').disabled = false;
      document.getElementById('fetchRdpBtn').innerHTML = '🔄 Retrying...';
      document.getElementById('rdpStatusText').textContent = e.message + ' (Retrying...)';
    } else {
      stopEtaTicker();
      fetchStartTime = 0;
      document.getElementById('rdpStatus').className = 'info-status error';
      document.getElementById('rdpStatusText').textContent = '❌ ' + e.message;
      setLoading('fetchRdpBtn', false);
    }
  }
}

function copyText(text, btn) {
  function onSuccess() {
    btn.classList.add('copied');
    btn.textContent = '\u2714 Copied!';
    setTimeout(function(){ btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    toast('Copied!');
  }
  function fallbackCopy() {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch(e) {
      toast('Copy failed', 'error');
    }
    document.body.removeChild(ta);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}
</script>
</body>
</html>`;

// ============================================================
// Admin Dashboard HTML
// ============================================================
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Admin - TrueTeam Cloud</title>
<meta name="theme-color" content="#0e0c12"/>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
	<style>
	*{margin:0;padding:0;box-sizing:border-box}
	:root{
	  color-scheme:dark;
	  --bg:#0e0c12;--bg2:#131117;--surface:#19171f;--surface2:#211e29;--surface3:#2a2634;
	  --border:#302c3a;--border2:#443d50;--border3:#5b526a;
	  --text:#f5f2fa;--text2:#b6afc2;--text3:#7f778d;
	  --accent:#b895ff;--accent2:#9f7aef;--accent3:#dccfff;
	  --accent-glow:rgba(184,149,255,0.17);
	  --red:#ef4444;--yellow:#eab308;--green:#22c55e;
	  --radius:6px;--radius-lg:8px;
	  --font-sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
	  --font-mono:'JetBrains Mono',Consolas,monospace;
	}
	body{
	  font-family:var(--font-sans);
	  background:var(--bg);color:var(--text);min-height:100vh;padding:16px;
	  -webkit-font-smoothing:antialiased;
	  background-attachment:fixed;
	  letter-spacing:0;
	}
@media(min-width:640px){body{padding:24px;}}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.container{max-width:960px;margin:0 auto;}
@keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
/* Header */
.admin-header{text-align:center;margin-bottom:24px;animation:slideUp 0.4s ease both;}
.admin-header h1{font-size:1.4rem;font-weight:600;color:#fff;letter-spacing:0;font-family:var(--font-sans);display:flex;align-items:center;justify-content:center;gap:10px;}
	.admin-header h1 span{
	  color:var(--accent);
	}
.admin-header p{color:var(--text3);font-size:0.78rem;margin-top:4px;}
/* Cards */
.card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius-lg);
  padding:16px;margin-bottom:12px;transition:border-color 0.15s ease;
}
@media(min-width:640px){.card{padding:24px;margin-bottom:16px;}}
.card:hover{border-color:var(--border2);}
.card h2{font-size:0.82rem;font-weight:600;margin-bottom:14px;color:var(--text);display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:0.02em;}
/* Inputs */
input,select{
  width:100%;padding:12px 14px;
  background:var(--surface);border:1px solid var(--border2);
  border-radius:var(--radius);color:var(--text);
  font-family:var(--font-sans);font-size:16px;
  margin-bottom:12px;outline:none;transition:all 0.2s;
}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);background:var(--surface2);}
input::placeholder{color:var(--text3);}
/* Buttons */
.btn{
  padding:9px 18px;border:1px solid transparent;border-radius:var(--radius);cursor:pointer;
  font-weight:500;font-size:0.82rem;margin-right:6px;margin-bottom:6px;
	  font-family:var(--font-sans);letter-spacing:0;
  transition:all 0.12s ease;touch-action:manipulation;
}
.btn:active{transform:scale(0.98);}
	.btn-accent{background:var(--accent);color:#1d122c;border-color:var(--accent);font-weight:600;}
	.btn-accent:hover{background:var(--accent2);border-color:var(--accent2);box-shadow:0 2px 12px var(--accent-glow);}
	.btn-red{background:transparent;color:var(--red);border-color:var(--border2);}
	.btn-red:hover{border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.06);}
	.btn-green{background:transparent;color:var(--accent);border-color:var(--border2);}
	.btn-green:hover{border-color:var(--accent);background:rgba(184,149,255,0.08);}
	.btn-sm{padding:6px 14px;font-size:0.72rem;border-radius:var(--radius);}
/* Table - desktop only */
table{width:100%;border-collapse:collapse;font-size:0.82rem;}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--border);}
th{color:var(--text3);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;}
td{font-family:'JetBrains Mono',monospace;font-size:0.78rem;word-break:break-all;color:var(--text2);}
tr{transition:background 0.1s;}
tr:hover td{background:rgba(255,255,255,0.02);}
/* Mobile card items - replaces tables on small screens */
.m-item{
  background:var(--surface);border:1px solid var(--border);border-radius:8px;
  padding:14px;margin-bottom:10px;
}
.m-item-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;}
.m-item-email{font-size:0.82rem;font-weight:600;color:var(--text);word-break:break-all;min-width:0;flex:1;}
.m-item-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--border);}
.m-item-label{font-size:0.68rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;font-weight:500;}
.m-item-value{font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--text2);text-align:right;word-break:break-all;max-width:60%;}
.m-item-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);}
.m-item-actions .btn-sm{flex:1;text-align:center;min-width:0;}
/* Badges */
.badge{padding:3px 10px;border-radius:9999px;font-size:0.64rem;font-weight:600;white-space:nowrap;font-family:var(--font-mono);letter-spacing:0.03em;border:1px solid transparent;}
.badge-green{background:rgba(184,149,255,0.10);color:var(--accent3);border-color:rgba(184,149,255,0.22);}
.badge-admin{background:rgba(184,149,255,0.18);color:var(--accent3);border-color:rgba(184,149,255,0.42);}
.badge-yellow{background:rgba(234,179,8,0.10);color:var(--yellow);border-color:rgba(234,179,8,0.22);}
.badge-red{background:rgba(239,68,68,0.10);color:var(--red);border-color:rgba(239,68,68,0.20);}
.badge-gray{background:var(--surface2);color:var(--text3);border-color:var(--border2);}
.role-stack{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:108px;}
.role-select{width:108px;height:30px;padding:4px 26px 4px 8px;margin:0;border-radius:5px;background:var(--surface2);font:500 0.7rem var(--font-sans);cursor:pointer;}
.role-select:disabled{cursor:wait;opacity:0.6;}
.m-item-actions .role-select{flex:1 1 132px;width:auto;min-width:132px;}
.hidden{display:none!important}
/* Stats */
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px;}
@media(min-width:640px){.stats{grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;}}
.stat{
  background:var(--surface);
  border:1px solid var(--border);border-radius:var(--radius);
  padding:14px 10px;text-align:center;transition:border-color 0.15s;
}
@media(min-width:640px){.stat{padding:20px;}}
.stat:hover{border-color:var(--border2);}
.stat-num{font-size:1.5rem;font-weight:700;color:var(--text);letter-spacing:0;font-family:var(--font-mono);}
@media(min-width:640px){.stat-num{font-size:2rem;}}
.stat-label{font-size:0.64rem;color:var(--text3);margin-top:2px;font-weight:500;text-transform:uppercase;letter-spacing:0.04em;}
@media(min-width:640px){.stat-label{font-size:0.7rem;margin-top:4px;}}
/* Tabs */
.tabs{display:flex;gap:3px;margin-bottom:16px;background:var(--bg);padding:3px;border-radius:var(--radius);border:1px solid var(--border);overflow-x:auto;scrollbar-width:none;}
.tabs::-webkit-scrollbar{display:none;}
.tabs button{
  flex:1 0 96px;padding:10px 8px;border:1px solid transparent;border-radius:4px;
  background:transparent;color:var(--text3);cursor:pointer;
  font-weight:500;font-size:0.78rem;transition:all 0.12s;
  font-family:var(--font-sans);
}
@media(min-width:640px){.tabs button{font-size:0.82rem;padding:10px;}}
.tabs button.active{background:var(--surface2);color:var(--text);border-color:var(--border2);box-shadow:none;}
.tabs button:hover:not(.active){color:var(--text2);}
/* Toast */
.toast-container{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;width:90%;max-width:360px;}
@media(min-width:640px){.toast-container{left:auto;right:20px;top:20px;transform:none;}}
.toast{
  padding:10px 16px;border-radius:var(--radius);margin-bottom:6px;font-size:0.8rem;font-weight:500;
  animation:slideIn 0.3s ease;border:1px solid var(--border);text-align:center;
}
@media(min-width:640px){.toast{text-align:left;}}
.toast-success{background:var(--surface);color:var(--accent);}
.toast-error{background:var(--surface);color:var(--red);border-color:rgba(239,68,68,0.2);}
@keyframes slideIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
/* Modal */
.modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,0.7);
  display:flex;align-items:flex-end;justify-content:center;z-index:100;
  animation:fadeIn 0.15s;padding:0;
}
@media(min-width:640px){.modal-overlay{align-items:center;padding:20px;}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{
  background:var(--bg2);border:1px solid var(--border);
  border-radius:var(--radius-lg) var(--radius-lg) 0 0;padding:24px;width:100%;max-width:400px;
  box-shadow:0 -8px 32px rgba(0,0,0,0.5);animation:modalSlideUp 0.25s ease;
}
@media(min-width:640px){
  .modal{border-radius:var(--radius-lg);animation:modalIn 0.2s ease;}
}
@keyframes modalSlideUp{from{opacity:0;transform:translateY(100%)}to{opacity:1;transform:translateY(0)}}
@keyframes modalIn{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}
.modal h3{margin-bottom:16px;color:var(--text);font-weight:600;font-size:1rem;}
.actions-bar{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;}
.spinner{width:16px;height:16px;border:2px solid rgba(29,18,44,0.25);border-top-color:#1d122c;border-radius:50%;animation:spin .65s linear infinite;margin:auto;}
@keyframes spin{to{transform:rotate(360deg)}}
.hint-box{padding:10px 12px;margin-bottom:14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);color:var(--text2);font-size:0.76rem;line-height:1.5;}
.machines-empty{padding:24px;text-align:center;color:var(--text3);font-size:0.78rem;}
.btn:disabled{opacity:.45;cursor:not-allowed;pointer-events:none;}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
.admin-identity{display:flex;align-items:center;gap:9px;min-width:150px;}
.admin-avatar{position:relative;width:30px;height:30px;border-radius:6px;object-fit:cover;background:#2b2140;color:var(--accent3);display:flex;align-items:center;justify-content:center;flex:0 0 auto;font:700 .62rem var(--font-sans);overflow:hidden;}
.admin-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}
.admin-identity-copy{min-width:0;}
.admin-identity-copy strong{display:block;color:var(--text);font:600 .75rem var(--font-sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;}
.admin-identity-copy span{display:block;margin-top:2px;color:var(--text3);font:500 .63rem var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;}
/* Console layout */
body{padding:0;background:var(--bg);overflow-x:hidden;}
.admin-app{min-height:100vh;}
.admin-shell{min-height:100vh;display:grid;grid-template-columns:232px minmax(0,1fr);}
.console-sidebar{position:sticky;top:0;height:100vh;padding:18px 14px;border-right:1px solid var(--border);background:#100e14;display:flex;flex-direction:column;gap:22px;z-index:20;}
.brand{display:flex;align-items:center;gap:10px;padding:4px 7px;color:var(--text);text-decoration:none;}
.brand-mark{width:34px;height:34px;padding:7px;border:1px solid rgba(184,149,255,.35);border-radius:7px;background:rgba(184,149,255,.1);display:grid;grid-template-columns:repeat(2,1fr);gap:3px;flex:0 0 auto;}
.brand-mark span{border-radius:1px;background:var(--accent);}
.brand-copy{min-width:0;}
.brand-copy strong,.brand-copy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.brand-copy strong{font-size:.82rem;}
.brand-copy small{margin-top:2px;color:var(--text3);font:500 .55rem var(--font-mono);text-transform:uppercase;}
.sidebar-label{padding:0 8px;color:var(--text3);font:600 .56rem var(--font-mono);text-transform:uppercase;}
.sidebar-nav{display:flex;flex-direction:column;gap:4px;}
.nav-item{width:100%;min-height:40px;padding:0 10px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--text3);display:flex;align-items:center;gap:10px;font:500 .74rem var(--font-sans);cursor:pointer;text-align:left;}
.nav-item:hover{color:var(--text2);background:rgba(255,255,255,.025);}
.nav-item.active{color:var(--text);border-color:rgba(184,149,255,.28);background:rgba(184,149,255,.11);}
.nav-item .nav-count{margin-left:auto;color:var(--text3);font:500 .56rem var(--font-mono);}
.sidebar-spacer{flex:1;}
.sidebar-note{padding:12px;border:1px solid var(--border);border-radius:7px;background:var(--surface);}
.sidebar-note strong{display:block;font-size:.7rem;}
.sidebar-note span{display:block;margin-top:5px;color:var(--text3);font-size:.62rem;line-height:1.45;}
.service-state{margin-top:12px;padding-left:13px;position:relative;color:var(--text3);font:500 .58rem var(--font-mono);}
.service-state::before{content:'';position:absolute;left:0;top:4px;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px rgba(184,149,255,.12);}
.admin-workspace{min-width:0;}
.admin-topbar{min-height:64px;padding:12px 24px;border-bottom:1px solid var(--border);background:rgba(14,12,18,.92);display:flex;align-items:center;justify-content:space-between;gap:16px;position:sticky;top:0;z-index:15;backdrop-filter:blur(12px);}
.breadcrumbs{display:flex;align-items:center;gap:8px;color:var(--text3);font-size:.68rem;white-space:nowrap;}
.breadcrumbs strong{color:var(--text2);font-weight:600;}.breadcrumbs .slash{color:var(--border3);}
.topbar-controls{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;}
.global-search{width:min(390px,36vw);height:38px;padding:0 8px 0 11px;border:1px solid var(--border);border-radius:6px;background:var(--surface);display:flex;align-items:center;gap:8px;transition:border-color .14s,box-shadow .14s;}
.global-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);}
.global-search input{min-width:0;height:36px;padding:0;margin:0;border:0;background:transparent;box-shadow:none;font-size:.75rem;}
.global-search input:focus{border:0;background:transparent;box-shadow:none;}
.search-clear{width:26px;height:26px;border:0;border-radius:4px;background:transparent;color:var(--text3);display:flex;align-items:center;justify-content:center;cursor:pointer;}
.search-clear:hover{color:var(--text);background:var(--surface2);}
.session-pill{height:38px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text2);display:flex;align-items:center;gap:8px;font-size:.68rem;white-space:nowrap;}
.session-pill strong{color:var(--accent3);font-size:.64rem;text-transform:uppercase;}
.workspace-content{width:min(100%,1480px);margin:0 auto;padding:28px 30px 42px;}
.page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:20px;}
.eyebrow{margin-bottom:6px;color:var(--accent);font:600 .58rem var(--font-mono);text-transform:uppercase;}
.page-heading h1{font-size:1.35rem;line-height:1.2;}.page-heading p{max-width:620px;margin-top:7px;color:var(--text3);font-size:.72rem;line-height:1.55;}
.result-count{color:var(--text3);font:500 .65rem var(--font-mono);white-space:nowrap;}
.content-panel{border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden;}
.panel-header{min-height:64px;padding:13px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;}
.panel-title{min-width:0;}.panel-title h2{margin:0;font-size:.82rem;text-transform:none;letter-spacing:0;}.panel-title p{margin-top:4px;color:var(--text3);font-size:.64rem;}
.panel-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;}
.panel-actions .btn{margin:0;}
.panel-actions .btn,.form-row .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;}
.data-list{min-width:0;}
.data-head,.data-row{display:grid;align-items:center;gap:12px;padding:0 16px;}
.data-head{min-height:38px;background:var(--bg2);color:var(--text3);font:600 .57rem var(--font-mono);text-transform:uppercase;}
.data-row{min-height:58px;border-top:1px solid var(--border);transition:background .12s;}
.data-row:hover{background:rgba(255,255,255,.018);}
.data-row.is-muted{opacity:.52;}
.user-grid{grid-template-columns:minmax(210px,1.65fr) 142px 92px minmax(120px,1fr) 62px 124px;}
.token-grid{grid-template-columns:minmax(180px,1.3fr) minmax(135px,1fr) minmax(135px,1fr) minmax(120px,.9fr) 88px 42px;}
.machine-grid{grid-template-columns:minmax(180px,1.15fr) minmax(230px,1.8fr) 125px 96px 148px;}
.credit-grid{grid-template-columns:minmax(220px,1fr) 110px;}
.data-cell{min-width:0;color:var(--text2);font-size:.7rem;overflow-wrap:anywhere;}
.data-cell.mono{font-family:var(--font-mono);font-size:.64rem;}
.data-cell a{color:var(--accent3);text-decoration:none;}.data-cell a:hover{text-decoration:underline;}
.data-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;}
.icon-btn{width:32px;height:32px;padding:0;margin:0;border:1px solid var(--border2);border-radius:5px;background:transparent;color:var(--text3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:all .12s;}
.icon-btn:hover{color:var(--text);border-color:var(--accent);background:rgba(184,149,255,.08);}.icon-btn.danger:hover{color:var(--red);border-color:rgba(239,68,68,.45);background:rgba(239,68,68,.07);}
.icon{width:16px;height:16px;stroke-width:1.8;}.icon-sm{width:14px;height:14px;}
.role-stack{min-width:0;}.role-control{height:32px;padding:0 6px 0 9px;border:1px solid var(--border2);border-radius:5px;background:var(--surface2);display:flex;align-items:center;gap:7px;}
.role-dot{width:6px;height:6px;border-radius:50%;background:var(--text3);flex:0 0 auto;}.role-control[data-role='seller'] .role-dot{background:#75d5ff}.role-control[data-role='admin'] .role-dot{background:var(--accent)}.role-control[data-role='owner'] .role-dot{background:var(--yellow)}
.role-select{width:100%;height:30px;padding:0 20px 0 0;margin:0;border:0;background:transparent;color:var(--text);color-scheme:dark;box-shadow:none;font:600 .66rem var(--font-sans);cursor:pointer;}.role-select option{background:#211e29;color:#f5f2fa;}.role-select option:disabled{color:#7f778d;}.role-select:focus{border:0;background:transparent;box-shadow:none;}
.secret-preview{font:500 .63rem var(--font-mono);color:var(--text3);white-space:nowrap;}
.secret-toggle{max-width:100%;padding:4px 7px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text3);display:inline-flex;align-items:center;gap:6px;font:500 .61rem var(--font-mono);cursor:pointer;}.secret-toggle:hover{color:var(--text2);border-color:var(--border2);}.secret-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.record-title{display:block;color:var(--text);font:600 .7rem var(--font-sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.record-sub{display:block;margin-top:3px;color:var(--text3);font-size:.6rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.empty-panel{padding:50px 20px;text-align:center;color:var(--text3);}.empty-panel strong{display:block;margin-top:10px;color:var(--text2);font-size:.76rem;}.empty-panel span{display:block;margin-top:4px;font-size:.64rem;}
.login-view{min-height:calc(100vh - 64px);display:grid;grid-template-columns:minmax(0,1.25fr) minmax(340px,.75fr);border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface);}
.login-visual{min-height:520px;padding:32px;position:relative;background:linear-gradient(90deg,rgba(14,12,18,.05),rgba(14,12,18,.78)),url('/assets/community-art.webp') center/cover;display:flex;align-items:flex-end;}
.login-visual-copy{max-width:520px;}.login-visual-copy h1{font-size:1.55rem;}.login-visual-copy p{margin-top:8px;color:var(--text2);font-size:.76rem;line-height:1.6;}
.login-form-shell{padding:34px;display:flex;flex-direction:column;justify-content:center;background:var(--bg2);}.login-form-shell h2{margin:0;font-size:1rem;text-transform:none;letter-spacing:0;}.login-form-shell>p{margin:7px 0 22px;color:var(--text3);font-size:.7rem;line-height:1.55;}
.login-form-shell label{display:block;margin-bottom:6px;color:var(--text2);font-size:.68rem;}.login-form-shell input{background:var(--surface);}
.finance-form,.settings-form{padding:18px;}.form-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(100px,.7fr) auto;gap:8px;align-items:start;}.form-row input{margin:0;}
.settings-card{max-width:780px;padding:18px;border:1px solid var(--border);border-radius:7px;background:var(--bg2);}.settings-card h3{font-size:.78rem;}.settings-card p{margin:7px 0 14px;color:var(--text3);font-size:.68rem;line-height:1.55;}
@media(max-width:900px){
	  .admin-shell{grid-template-columns:minmax(0,1fr);}.console-sidebar{position:relative;width:100%;min-width:0;max-width:100vw;height:auto;padding:10px 12px;border-right:0;border-bottom:1px solid var(--border);gap:10px;overflow:hidden;}.console-sidebar .sidebar-label,.sidebar-note,.service-state{display:none;}#adminNav,.brand,.sidebar-nav{width:100%;min-width:0;max-width:100%;}.sidebar-nav{flex-direction:row;overflow-x:auto;scrollbar-width:none;}.sidebar-nav::-webkit-scrollbar{display:none}.nav-item{width:auto;min-width:108px;flex:0 0 auto;}.sidebar-spacer{display:none}.admin-workspace{width:100%;max-width:100vw;overflow-x:hidden;}.admin-topbar{top:0;}.login-view{grid-template-columns:1fr;}.login-visual{min-height:260px;}.login-form-shell{padding:26px;}
}
@media(max-width:720px){
	  .admin-topbar{top:0;padding:10px 14px;flex-wrap:wrap;}.breadcrumbs{display:none}.topbar-controls{width:100%;min-width:0;}.global-search{width:0;min-width:0;flex:1 1 auto;}.global-search input{width:0;min-width:0;flex:1 1 0;}.session-pill{flex:0 0 auto;}.session-pill span{display:none}.workspace-content{width:100%;max-width:100%;padding:20px 14px 34px;}.page-heading{align-items:flex-start;flex-direction:column;}.stats{min-width:0;grid-template-columns:repeat(2,minmax(0,1fr));}.content-panel{min-width:0;}.panel-header{align-items:flex-start;flex-direction:column;}.panel-actions{justify-content:flex-start;}.data-head{display:none}.data-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:13px 14px;}.data-cell{grid-column:1/-1;display:grid;grid-template-columns:82px minmax(0,1fr);gap:10px;align-items:start;}.data-cell::before{content:attr(data-label);color:var(--text3);font:600 .56rem var(--font-mono);text-transform:uppercase;}.data-cell.identity{display:block}.data-cell.identity::before{display:none}.data-cell>.badge{width:max-content;max-width:100%;justify-self:start;}.data-actions{grid-column:1/-1;justify-content:flex-start;padding-top:8px;border-top:1px solid var(--border);}.role-control{width:150px;max-width:100%;}.form-row{grid-template-columns:1fr;}.login-visual{min-height:220px;padding:22px}.login-form-shell{padding:22px}.admin-identity-copy strong,.admin-identity-copy span{max-width:220px;}
}
@media(max-width:420px){.brand-copy small{display:none}.nav-item{min-width:96px}.session-pill{padding:0 8px}.login-visual-copy h1{font-size:1.2rem}.stats{gap:8px}.stat{padding:12px 8px}.stat-num{font-size:1.25rem}.admin-identity-copy strong,.admin-identity-copy span{max-width:190px;}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;}}
</style>
</head>
<body>
<div class="toast-container" id="toastContainer" aria-live="polite"></div>
<div id="modalContainer"></div>

<div class="admin-app">
  <div class="admin-shell">
    <aside class="console-sidebar" aria-label="Admin navigation">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
        <span class="brand-copy"><strong>TrueTeam Admin</strong><small>Control workspace</small></span>
      </div>

      <div id="adminNav" class="hidden">
        <div class="sidebar-label">Management</div>
        <nav class="sidebar-nav" style="margin-top:8px;">
          <button class="nav-item active" data-admin-tab="users" onclick="switchTab('users',this)"><i data-lucide="users" class="icon" aria-hidden="true">U</i><span>Users</span><span class="nav-count" id="navUsersCount">0</span></button>
          <button class="nav-item" data-admin-tab="tokens" onclick="switchTab('tokens',this)"><i data-lucide="key-round" class="icon" aria-hidden="true">K</i><span>Tokens</span><span class="nav-count" id="navTokensCount">0</span></button>
          <button class="nav-item" data-admin-tab="machines" onclick="switchTab('machines',this)"><i data-lucide="server" class="icon" aria-hidden="true">M</i><span>Machines</span><span class="nav-count" id="navMachinesCount">0</span></button>
          <button class="nav-item" data-admin-tab="finance" onclick="switchTab('finance',this)"><i data-lucide="coins" class="icon" aria-hidden="true">F</i><span>Finance</span></button>
          <button class="nav-item" data-admin-tab="settings" onclick="switchTab('settings',this)"><i data-lucide="settings-2" class="icon" aria-hidden="true">S</i><span>Settings</span></button>
        </nav>
      </div>

      <div class="sidebar-spacer"></div>
      <div class="sidebar-note"><strong>TrueTeam Community</strong><span>Operations, access control, and service health in one workspace.</span></div>
      <div class="service-state">Production online</div>
    </aside>

    <main class="admin-workspace">
      <header class="admin-topbar">
        <div class="breadcrumbs"><span>TrueTeam</span><span class="slash">/</span><strong>Admin console</strong></div>
        <div class="topbar-controls">
          <div class="global-search hidden" id="adminSearchShell">
            <i data-lucide="search" class="icon icon-sm" aria-hidden="true">?</i>
            <input type="search" id="adminSearchInput" placeholder="Search users" autocomplete="off" oninput="handleAdminSearch(this.value)" onkeydown="if(event.key==='Escape')clearAdminSearch()" />
            <button type="button" class="search-clear hidden" id="adminSearchClear" onclick="clearAdminSearch()" aria-label="Clear search"><i data-lucide="x" class="icon icon-sm" aria-hidden="true">x</i></button>
          </div>
          <div class="session-pill hidden" id="adminSessionControls"><span>Signed in as</span><strong>Admin</strong><button type="button" class="search-clear" onclick="logoutAdmin()" aria-label="Sign out"><i data-lucide="log-out" class="icon icon-sm" aria-hidden="true">x</i></button></div>
        </div>
      </header>

      <div class="workspace-content">
        <section class="login-view" id="loginCard">
          <div class="login-visual">
            <div class="login-visual-copy"><div class="eyebrow">Secure operations</div><h1>Run the community cloud from one calm workspace.</h1><p>Monitor accounts, access tokens, machines, and shared service settings.</p></div>
          </div>
          <form class="login-form-shell" onsubmit="event.preventDefault();adminLogin();">
            <div class="eyebrow">Administrator access</div>
            <h2>Sign in to continue</h2>
            <p>Use an Admin or Owner account. Leave email empty to use the master password.</p>
            <label for="adminEmailInput">Email address</label>
            <input type="email" id="adminEmailInput" placeholder="Email (admin or owner account)" autocomplete="email" />
            <label for="adminPassInput">Password</label>
            <input type="password" id="adminPassInput" placeholder="Password" autocomplete="current-password" required />
            <button type="submit" class="btn btn-accent" id="adminLoginButton" style="width:100%;margin:4px 0 0;">Sign in</button>
          </form>
        </section>

        <div id="dashboard" class="hidden">
          <header class="page-heading">
            <div><div class="eyebrow">Operations workspace</div><h1 id="adminPageTitle">Users</h1><p id="adminPageCopy">Manage identity, access level, and account security.</p></div>
            <div class="result-count" id="adminResultCount">0 records</div>
          </header>

          <section class="stats" id="statsPanel" aria-label="Service metrics"></section>

          <section class="content-panel" id="tab-users">
            <header class="panel-header"><div class="panel-title"><h2>User directory</h2><p>Identity, permissions, token state, and machine count.</p></div><div class="panel-actions"><button class="icon-btn" onclick="loadUsers()" aria-label="Refresh users" title="Refresh users"><i data-lucide="refresh-cw" class="icon" aria-hidden="true">R</i></button></div></header>
            <div id="usersTable"></div>
          </section>

          <section class="content-panel hidden" id="tab-tokens">
            <header class="panel-header"><div class="panel-title"><h2>Token health</h2><p>GitHub and Ngrok credentials across active accounts.</p></div><div class="panel-actions"><button class="icon-btn" onclick="loadTokens()" aria-label="Refresh tokens" title="Refresh tokens"><i data-lucide="refresh-cw" class="icon" aria-hidden="true">R</i></button><button class="btn btn-accent btn-sm" id="checkAllBtn" onclick="checkAllTokens()"><i data-lucide="scan-search" class="icon icon-sm" aria-hidden="true">C</i>Check all</button><button class="btn btn-green btn-sm" onclick="exportTokens('live')"><i data-lucide="download" class="icon icon-sm" aria-hidden="true">D</i>Live</button><button class="btn btn-red btn-sm" onclick="exportTokens('dead')"><i data-lucide="download" class="icon icon-sm" aria-hidden="true">D</i>Dead</button></div></header>
            <div id="tokensTable"></div>
          </section>

          <section class="content-panel hidden" id="tab-machines">
            <header class="panel-header"><div class="panel-title"><h2>Machine inventory</h2><p>Current endpoints, credentials, state, and creation time.</p></div><div class="panel-actions"><button class="icon-btn" onclick="loadMachines()" aria-label="Refresh machines" title="Refresh machines"><i data-lucide="refresh-cw" class="icon" aria-hidden="true">R</i></button></div></header>
            <div id="machinesTable"></div>
          </section>

          <section class="content-panel hidden" id="tab-finance">
            <header class="panel-header"><div class="panel-title"><h2>Finance</h2><p>Credit balances and account adjustments.</p></div><div class="panel-actions"><button class="icon-btn" onclick="loadCredits()" aria-label="Refresh credits" title="Refresh credits"><i data-lucide="refresh-cw" class="icon" aria-hidden="true">R</i></button></div></header>
            <div class="finance-form"><div class="form-row"><input type="email" id="creditEmailInput" placeholder="user@example.com" aria-label="Account email" /><input type="number" id="creditAmountInput" placeholder="Amount" aria-label="Credit amount" /><button class="btn btn-green" onclick="addCredits()"><i data-lucide="plus" class="icon icon-sm" aria-hidden="true">+</i>Add credits</button></div></div>
            <div id="creditsTable"><div class="empty-panel"><i data-lucide="coins" class="icon" aria-hidden="true">C</i><strong>No credit records loaded</strong></div></div>
          </section>

          <section class="content-panel hidden" id="tab-settings">
            <header class="panel-header"><div class="panel-title"><h2>Shared settings</h2><p>Production defaults used by new deployments.</p></div></header>
            <div class="settings-form"><div class="settings-card"><h3>Ngrok Fast shared token</h3><p>Used for new Ngrok Fast deployments until replaced or reset.</p><div class="form-row"><input type="password" id="ngrokFastInput" placeholder="2v8...xxxxxx" autocomplete="off" /><button class="btn btn-green" onclick="saveNgrokFastToken()">Save</button><button class="btn btn-red" onclick="resetNgrokFastToken()">Reset</button></div><div id="ngrokFastStatus" style="margin-top:10px;font-size:.68rem;color:var(--text3);"></div></div></div>
          </section>
        </div>
      </div>
    </main>
  </div>
</div>

<script>
var adminToken = '';
var usersData = [];
var tokensData = [];
var machinesData = [];
var creditsData = [];
var activeAdminTab = 'users';
var adminSearchByTab = { users: '', tokens: '', machines: '', finance: '' };
var API_BASE = location.hostname.startsWith('admin.') ? '/api/' : '/api/admin/';

function renderAdminIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function adminIdentity(u) {
  var username = u.username || String(u.email || '').split('@')[0] || 'User';
  var initials = username.slice(0, 2).toUpperCase();
  var image = u.avatarUrl ? '<img src="' + esc(u.avatarUrl) + '" alt=""/>' : '';
  return '<div class="admin-identity"><span class="admin-avatar"><span>' + esc(initials) + '</span>' + image + '</span>'
    + '<span class="admin-identity-copy"><strong>' + esc(username) + '</strong><span>' + esc(u.email) + '</span></span></div>';
}

function toast(msg, type) {
  var c = document.getElementById('toastContainer');
  var t = document.createElement('div');
  t.className = 'toast toast-' + (type || 'success');
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(function(){ t.remove(); }, 3000);
}

		function adminApi(path, data) {
		  var payload = Object.assign({}, data || {}, { adminToken: adminToken });
		  return fetch(API_BASE + path, {
		    method: 'POST',
		    headers: { 'Content-Type': 'application/json' },
		    body: JSON.stringify(payload),
		  }).then(function(r){
		    return r.json().catch(function(){
		      return r.text().then(function(t){
		        throw new Error(t ? t.slice(0,200) : 'HTTP ' + r.status);
		      });
		    });
		  }).then(function(j){
		    if (j && j.error) throw new Error(j.error);
		    return j;
		  });
		}

	async function adminLogin() {
	  var btn = document.querySelector('#loginCard .btn-accent');
	  var origHtml = btn ? btn.innerHTML : '';
	  try {
	    var email = document.getElementById('adminEmailInput').value.trim();
	    var pass = document.getElementById('adminPassInput').value;
	    if (!pass) { toast('Please enter a password', 'error'); return; }

	    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="border-top-color:#0e1111;width:14px;height:14px;margin:0 auto;"></div>'; }

	    var res = await fetch(API_BASE + 'login', {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ password: pass, email: email || undefined })
	    });

	    var d;
	    try { d = await res.json(); } catch(e) { throw new Error('Server returned invalid response (HTTP ' + res.status + ')'); }

	    if (d.error) { throw new Error(d.error); }

	    adminToken = d.adminToken;
	    document.getElementById('loginCard').classList.add('hidden');
	    document.getElementById('dashboard').classList.remove('hidden');
	    document.getElementById('adminNav').classList.remove('hidden');
	    document.getElementById('adminSearchShell').classList.remove('hidden');
	    document.getElementById('adminSessionControls').classList.remove('hidden');
	    toast('Logged in successfully');
	    loadAll();
	    renderAdminIcons();
	  } catch(e) {
	    toast(e.message || 'Login failed', 'error');
	  } finally {
	    if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
	  }
	}

	function loadAll() {
	  loadUsers();
	  loadTokens();
	  loadMachines();
	  loadCredits();
	}

	function logoutAdmin() {
	  adminToken = '';
	  document.getElementById('dashboard').classList.add('hidden');
	  document.getElementById('loginCard').classList.remove('hidden');
	  document.getElementById('adminNav').classList.add('hidden');
	  document.getElementById('adminSearchShell').classList.add('hidden');
	  document.getElementById('adminSessionControls').classList.add('hidden');
	  document.getElementById('adminPassInput').value = '';
	  clearAdminSearch();
	  toast('Signed out');
	}

	function switchTab(name, btn) {
	  ['users','tokens','machines','finance','settings'].forEach(function(t){
	    document.getElementById('tab-' + t).classList.add('hidden');
	  });
	  document.getElementById('tab-' + name).classList.remove('hidden');
	  document.querySelectorAll('[data-admin-tab]').forEach(function(b){ b.classList.toggle('active', b.dataset.adminTab === name); });
	  activeAdminTab = name;
	  var meta = {
	    users: ['Users', 'Manage identity, access level, and account security.', 'Search users, email, owner, or role'],
	    tokens: ['Tokens', 'Review credential availability and token health.', 'Search token owner, email, or status'],
	    machines: ['Machines', 'Inspect active endpoints and machine lifecycle.', 'Search user, endpoint, or status'],
	    finance: ['Finance', 'Review balances and issue account credits.', 'Search credit accounts'],
	    settings: ['Settings', 'Manage shared production defaults.', '']
	  }[name];
	  document.getElementById('adminPageTitle').textContent = meta[0];
	  document.getElementById('adminPageCopy').textContent = meta[1];
	  var searchShell = document.getElementById('adminSearchShell');
	  var searchInput = document.getElementById('adminSearchInput');
	  searchShell.classList.toggle('hidden', name === 'settings');
	  searchInput.placeholder = meta[2];
	  searchInput.value = adminSearchByTab[name] || '';
	  document.getElementById('adminSearchClear').classList.toggle('hidden', !searchInput.value);
	  if (name === 'settings') document.getElementById('adminResultCount').textContent = 'Shared configuration';
	  else renderActiveAdminTab();
	  if (name === 'settings') loadNgrokFastToken();
	  if (name === 'finance') loadCredits();
	  renderAdminIcons();
}

function handleAdminSearch(value) {
  if (activeAdminTab === 'settings') return;
  adminSearchByTab[activeAdminTab] = String(value || '').trim().toLowerCase();
  document.getElementById('adminSearchClear').classList.toggle('hidden', !adminSearchByTab[activeAdminTab]);
  renderActiveAdminTab();
}

function clearAdminSearch() {
  if (activeAdminTab !== 'settings') adminSearchByTab[activeAdminTab] = '';
  var input = document.getElementById('adminSearchInput');
  if (input) input.value = '';
  var clear = document.getElementById('adminSearchClear');
  if (clear) clear.classList.add('hidden');
  renderActiveAdminTab();
}

function renderActiveAdminTab() {
  if (activeAdminTab === 'users') renderUsers();
  if (activeAdminTab === 'tokens') renderTokens();
  if (activeAdminTab === 'machines') renderMachines();
  if (activeAdminTab === 'finance') renderCredits();
}

function loadNgrokFastToken() {
  var statusEl = document.getElementById('ngrokFastStatus');
  statusEl.textContent = 'Loading...';
  adminApi('get-ngrok-fast-token', {}).then(function(d) {
    document.getElementById('ngrokFastInput').value = d.token || '';
    statusEl.innerHTML = d.overridden
      ? '<span style="color:var(--accent3);">● Đang dùng token tuỳ chỉnh (KV override)</span>'
      : '<span style="color:var(--text3);">○ Đang dùng token mặc định trong code</span>';
  }).catch(function(e){
    statusEl.innerHTML = '<span style="color:var(--red);">' + e.message + '</span>';
  });
}

function saveNgrokFastToken() {
  var token = document.getElementById('ngrokFastInput').value.trim();
  if (!token) return toast('Nhập token','error');
  if (token.length < 10) return toast('Token quá ngắn','error');
  adminApi('set-ngrok-fast-token', { token: token }).then(function() {
    toast('Đã cập nhật Ngrok Fast token');
    loadNgrokFastToken();
  }).catch(function(e){ toast(e.message, 'error'); });
}

function resetNgrokFastToken() {
  if (!confirm('Reset về token mặc định trong code?')) return;
  adminApi('set-ngrok-fast-token', { reset: true }).then(function() {
    toast('Đã reset về default');
    loadNgrokFastToken();
  }).catch(function(e){ toast(e.message, 'error'); });
}

function tokenBadge(has, status) {
  if (!has) return '<span class="badge badge-gray">NONE</span>';
  return '<span class="badge ' + (status === 'dead' ? 'badge-red' : 'badge-green') + '">' + (status === 'dead' ? 'DEAD' : 'LIVE') + '</span>';
}

function matchesAdminQuery(tab, values) {
  var query = adminSearchByTab[tab] || '';
  if (!query) return true;
  return values.map(function(value){ return String(value == null ? '' : value).toLowerCase(); }).join(' ').includes(query);
}

function setAdminResultCount(shown, total) {
  var label = shown === total ? total + ' records' : shown + ' / ' + total + ' records';
  document.getElementById('adminResultCount').textContent = label;
}

function emptyList(title, copy) {
  return '<div class="empty-panel"><i data-lucide="search-x" class="icon" aria-hidden="true">0</i><strong>' + esc(title) + '</strong><span>' + esc(copy || '') + '</span></div>';
}

function actionButton(icon, label, handler, danger) {
  return '<button type="button" class="icon-btn' + (danger ? ' danger' : '') + '" onclick="' + handler + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"><i data-lucide="' + icon + '" class="icon icon-sm" aria-hidden="true">*</i></button>';
}

function tokenPreview(value, label) {
  if (!value) return '<span class="secret-preview">Not set</span>';
  var text = String(value);
  var masked = '•••• ' + text.slice(-6);
  return '<button type="button" class="secret-toggle" data-secret="' + esc(text) + '" data-masked="' + esc(masked) + '" data-revealed="false" onclick="toggleSecret(this)" aria-label="Reveal ' + esc(label || 'secret') + '"><span class="secret-text">' + esc(masked) + '</span><i data-lucide="eye" class="icon icon-sm" aria-hidden="true">*</i></button>';
}

function toggleSecret(button) {
  var revealed = button.dataset.revealed === 'true';
  button.dataset.revealed = revealed ? 'false' : 'true';
  button.querySelector('.secret-text').textContent = revealed ? button.dataset.masked : button.dataset.secret;
  button.setAttribute('aria-label', revealed ? 'Reveal secret' : 'Hide secret');
}

function safeHttpUrl(value) {
  try {
    var parsed = new URL(String(value || ''), location.origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch (e) {
    return '';
  }
}

function formatAdminDate(value) {
  var date = new Date(value);
  return isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

	function roleBadge(role) {
	  if (!role || role === 'user') return '<span class="badge badge-gray">user</span>';
	  if (role === 'seller') return '<span class="badge badge-green">seller</span>';
	  if (role === 'admin') return '<span class="badge badge-admin">admin</span>';
	  if (role === 'owner') return '<span class="badge badge-yellow">owner</span>';
	  return '<span class="badge badge-gray">' + esc(role) + '</span>';
	}

	function roleSelect(u) {
	  var roles = ['user', 'seller', 'admin', 'owner'];
	  var current = roles.includes(u.role) ? u.role : 'user';
	  var options = roles.map(function(role) {
	    var label = role.charAt(0).toUpperCase() + role.slice(1);
	    return '<option value="' + role + '"' + (role === current ? ' selected' : '') + '>' + label + '</option>';
	  }).join('');
	  return '<span class="role-control" data-role="' + current + '"><span class="role-dot" aria-hidden="true"></span><select class="role-select" aria-label="Change role for ' + esc(u.email) + '" data-current="' + current + '" onchange="setRole(&quot;' + esc(u.email) + '&quot;,this.value,this)">' + options + '</select></span>';
	}

	function loadUsers() {
	  adminApi('users').then(function(d) {
	    usersData = d.users || [];
	    updateStats();
	    renderUsers();
	  }).catch(function(e){ toast(e.message, 'error'); });
	}

	function renderUsers() {
	  var filtered = usersData.filter(function(u) {
	    return matchesAdminQuery('users', [u.username, u.email, u.role, u.owner, u.hasToken ? u.tokenStatus : 'none']);
	  });
	  if (activeAdminTab === 'users') setAdminResultCount(filtered.length, usersData.length);
	  var head = '<div class="data-head user-grid"><span>Identity</span><span>Role</span><span>Token</span><span>GitHub owner</span><span>VMs</span><span></span></div>';
	  var rows = filtered.map(function(u) {
	    var emailArg = '&quot;' + esc(u.email) + '&quot;';
	    var actions = actionButton('key-round', 'Reset password', 'showResetModal(' + emailArg + ')', false)
	      + actionButton('trash-2', 'Delete user', 'showDeleteModal(' + emailArg + ')', true)
	      + (u.hasToken ? actionButton('shield-off', 'Revoke token', 'revokeToken(' + emailArg + ')', true) : '');
	    return '<div class="data-row user-grid">'
	      + '<div class="data-cell identity">' + adminIdentity(u) + '</div>'
	      + '<div class="data-cell" data-label="Role">' + roleSelect(u) + '</div>'
	      + '<div class="data-cell" data-label="Token">' + tokenBadge(u.hasToken, u.tokenStatus) + '</div>'
	      + '<div class="data-cell mono" data-label="GitHub owner">' + esc(u.owner || '-') + '</div>'
	      + '<div class="data-cell mono" data-label="VMs">' + (Number(u.machineCount) || 0) + '</div>'
	      + '<div class="data-actions">' + actions + '</div></div>';
	  }).join('');
	  document.getElementById('usersTable').innerHTML = filtered.length ? '<div class="data-list">' + head + rows + '</div>' : emptyList('No users found', 'Try another search term.');
	  renderAdminIcons();
	}

	function setRole(email, role, select) {
	  var current = select ? select.dataset.current : '';
	  if (role === current) return;
	  if (!confirm('Set role "' + role + '" for ' + email + '?')) {
	    if (select) select.value = current;
	    return;
	  }
	  if (select) select.disabled = true;
	  adminApi('set-role', { email: email, role: role }).then(function(d) {
	    toast('Role set: ' + d.email + ' -> ' + d.role);
	    loadUsers();
	  }).catch(function(e){
	    if (select) select.value = current;
	    toast(e.message, 'error');
	  }).finally(function(){
	    if (select) select.disabled = false;
	  });
	}

function loadTokens() {
  adminApi('tokens').then(function(d) {
    tokensData = d.tokens || [];
    updateStats();
    renderTokens();
  }).catch(function(e){ toast(e.message, 'error'); });
}

function renderTokens() {
  var filtered = tokensData.filter(function(t) {
    return matchesAdminQuery('tokens', [t.email, t.owner, t.status, t.deadReason, t.githubToken ? 'github' : '', t.ngrokToken ? 'ngrok' : '']);
  });
  if (activeAdminTab === 'tokens') setAdminResultCount(filtered.length, tokensData.length);
  var head = '<div class="data-head token-grid"><span>Account</span><span>GitHub</span><span>Ngrok</span><span>Owner</span><span>Status</span><span></span></div>';
  var rows = filtered.map(function(t) {
    var emailArg = '&quot;' + esc(t.email) + '&quot;';
    var status = t.status === 'dead' ? 'DEAD' : 'LIVE';
    var action = t.githubToken ? actionButton('scan-search', 'Check token', 'checkOneToken(' + emailArg + ',this)', false) : '';
    return '<div class="data-row token-grid">'
      + '<div class="data-cell identity"><span class="record-title">' + esc(t.email) + '</span><span class="record-sub">' + esc(t.deadReason || 'No reported issue') + '</span></div>'
      + '<div class="data-cell" data-label="GitHub">' + tokenPreview(t.githubToken, 'GitHub token') + '</div>'
      + '<div class="data-cell" data-label="Ngrok">' + tokenPreview(t.ngrokToken, 'Ngrok token') + '</div>'
      + '<div class="data-cell mono" data-label="Owner">' + esc(t.owner || '-') + '</div>'
      + '<div class="data-cell" data-label="Status"><span class="badge ' + (status === 'DEAD' ? 'badge-red' : 'badge-green') + '">' + status + '</span></div>'
      + '<div class="data-actions">' + action + '</div></div>';
  }).join('');
  document.getElementById('tokensTable').innerHTML = filtered.length ? '<div class="data-list">' + head + rows + '</div>' : emptyList('No tokens found', 'Try another search term.');
  renderAdminIcons();
}

function loadMachines() {
  adminApi('machines').then(function(d) {
    machinesData = d.machines || [];
    updateStats();
    renderMachines();
  }).catch(function(e){ toast(e.message, 'error'); });
}

function renderMachines() {
  var filtered = machinesData.filter(function(m) {
    var status = m.isExpired ? 'expired' : m.status === 'dead' ? 'dead' : 'active';
    return matchesAdminQuery('machines', [m.userEmail, m.ngrok_url, status, formatAdminDate(m.createdAt)]);
  });
  if (activeAdminTab === 'machines') setAdminResultCount(filtered.length, machinesData.length);
  var head = '<div class="data-head machine-grid"><span>User</span><span>Endpoint</span><span>Password</span><span>Status</span><span>Created</span></div>';
  var rows = filtered.map(function(m) {
    var status = m.isExpired ? 'EXPIRED' : m.status === 'dead' ? 'DEAD' : 'ACTIVE';
    var url = safeHttpUrl(m.ngrok_url);
    var urlCell = url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(m.ngrok_url) + '</a>' : '-';
    return '<div class="data-row machine-grid' + (m.isExpired ? ' is-muted' : '') + '">'
      + '<div class="data-cell identity"><span class="record-title">' + esc(m.userEmail || '-') + '</span><span class="record-sub">' + esc(m.repo || 'Cloud machine') + '</span></div>'
      + '<div class="data-cell mono" data-label="Endpoint">' + urlCell + '</div>'
      + '<div class="data-cell" data-label="Password">' + tokenPreview(m.password || 'hieudz', 'machine password') + '</div>'
      + '<div class="data-cell" data-label="Status"><span class="badge ' + (status === 'ACTIVE' ? 'badge-green' : 'badge-red') + '">' + status + '</span></div>'
      + '<div class="data-cell mono" data-label="Created">' + esc(formatAdminDate(m.createdAt)) + '</div></div>';
  }).join('');
  document.getElementById('machinesTable').innerHTML = filtered.length ? '<div class="data-list">' + head + rows + '</div>' : emptyList('No machines found', 'Try another search term.');
  renderAdminIcons();
}

function updateStats() {
  var totalUsers = usersData.length || 0;
  var liveTokens = tokensData.filter(function(t){ return t.status !== 'dead'; }).length;
  var deadTokens = tokensData.filter(function(t){ return t.status === 'dead'; }).length;
  var activeMachines = machinesData.filter(function(m){ return !m.isExpired && m.status !== 'dead'; }).length;
  document.getElementById('statsPanel').innerHTML =
    '<div class="stat"><i data-lucide="users" class="icon" aria-hidden="true">U</i><div class="stat-num">' + totalUsers + '</div><div class="stat-label">Total users</div></div>'
    + '<div class="stat"><i data-lucide="shield-check" class="icon" aria-hidden="true">L</i><div class="stat-num" style="color:var(--accent3)">' + liveTokens + '</div><div class="stat-label">Live tokens</div></div>'
    + '<div class="stat"><i data-lucide="shield-alert" class="icon" aria-hidden="true">D</i><div class="stat-num" style="color:var(--red)">' + deadTokens + '</div><div class="stat-label">Dead tokens</div></div>'
    + '<div class="stat"><i data-lucide="server" class="icon" aria-hidden="true">M</i><div class="stat-num" style="color:var(--accent3)">' + activeMachines + '</div><div class="stat-label">Active machines</div></div>';
  document.getElementById('navUsersCount').textContent = totalUsers;
  document.getElementById('navTokensCount').textContent = tokensData.length || 0;
  document.getElementById('navMachinesCount').textContent = machinesData.length || 0;
  renderAdminIcons();
}

function showResetModal(email) {
  document.getElementById('modalContainer').innerHTML =
    '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">'
    + '<div class="modal"><h3>Reset Password</h3>'
    + '<p style="color:var(--text2);margin-bottom:14px;font-size:0.85rem;">' + email + '</p>'
    + '<input type="password" id="newPassInput" placeholder="New password (min 6 chars)"/>'
    + '<div style="display:flex;gap:8px;"><button class="btn btn-accent" onclick="doResetPassword(&quot;' + email + '&quot;)">Reset</button>'
    + '<button class="btn" style="background:transparent;color:var(--text3);border:1px solid var(--border);" onclick="closeModal()">Cancel</button></div>'
    + '</div></div>';
}

function showDeleteModal(email) {
  document.getElementById('modalContainer').innerHTML =
    '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">'
    + '<div class="modal"><h3>Delete User</h3>'
    + '<p style="color:var(--red);margin-bottom:14px;font-size:0.85rem;">Delete <strong>' + email + '</strong>? This cannot be undone.</p>'
    + '<div style="display:flex;gap:8px;"><button class="btn" style="background:var(--red);color:#fff;" onclick="doDeleteUser(&quot;' + email + '&quot;)">Delete</button>'
    + '<button class="btn" style="background:transparent;color:var(--text3);border:1px solid var(--border);" onclick="closeModal()">Cancel</button></div>'
    + '</div></div>';
}

function closeModal() {
  document.getElementById('modalContainer').innerHTML = '';
}

function doResetPassword(email) {
  var newPass = document.getElementById('newPassInput').value;
  if (!newPass || newPass.length < 6) return toast('Min 6 characters', 'error');
  adminApi('reset-password', { email: email, newPassword: newPass }).then(function() {
    closeModal();
    toast('Password reset for ' + email);
  }).catch(function(e){ toast(e.message, 'error'); });
}

function doDeleteUser(email) {
  adminApi('delete-user', { email: email }).then(function() {
    closeModal();
    loadUsers();
    toast('User deleted: ' + email);
  }).catch(function(e){ toast(e.message, 'error'); });
}

function revokeToken(email) {
  if (!confirm('Revoke GitHub token for ' + email + '?')) return;
  adminApi('revoke-token', { email: email }).then(function() {
    loadUsers();
    loadTokens();
    toast('Token revoked for ' + email);
  }).catch(function(e){ toast(e.message, 'error'); });
}

function checkAllTokens() {
  var btn = document.getElementById('checkAllBtn');
  btn.disabled = true;
  var orig = btn.innerHTML;
  btn.textContent = 'Checking...';
  adminApi('check-tokens', {}).then(function(d) {
    toast('Checked ' + d.total + ' · ' + d.aliveCount + ' live · ' + d.deadCount + ' dead');
    loadTokens();
    loadUsers();
  }).catch(function(e){ toast(e.message, 'error'); }).finally(function() {
    btn.disabled = false;
    btn.innerHTML = orig;
    renderAdminIcons();
  });
}

function checkOneToken(email, btn) {
  btn.disabled = true;
  var orig = btn.innerHTML;
  btn.textContent = '...';
  adminApi('check-tokens', { emails: [email] }).then(function(d) {
    var r = (d.results && d.results[0]) || {};
    if (r.alive) toast('LIVE · ' + email + (r.login ? ' (' + r.login + ')' : ''));
    else toast('DEAD · ' + email + ' · ' + (r.reason || ''), 'error');
    loadTokens();
    loadUsers();
  }).catch(function(e){
    toast(e.message, 'error');
    btn.disabled = false;
    btn.innerHTML = orig;
    renderAdminIcons();
  });
}

	function exportTokens(type) {
	  var filtered = tokensData.filter(function(t) {
	    return type === 'live' ? t.status !== 'dead' : t.status === 'dead';
	  });
	  var text = filtered.map(function(t){ return t.githubToken; }).join('\\n');
	  var blob = new Blob([text], { type: 'text/plain' });
	  var a = document.createElement('a');
	  a.href = URL.createObjectURL(blob);
	  a.download = 'tokens-' + type + '.txt';
	  a.click();
	  toast('Exported ' + filtered.length + ' ' + type + ' tokens');
	}

	// ===== Admin: Finance / Credits =====
	function loadCredits() {
	  adminApi('credits-log', {}).then(function(d){
	    creditsData = d.entries || [];
	    renderCredits();
	  }).catch(function(e){ toast(e.message, 'error'); });
	}

	function renderCredits() {
	  var filtered = creditsData.filter(function(entry) {
	    return matchesAdminQuery('finance', [entry.email, entry.credits]);
	  });
	  if (activeAdminTab === 'finance') setAdminResultCount(filtered.length, creditsData.length);
	  var head = '<div class="data-head credit-grid"><span>Account</span><span>Credits</span></div>';
	  var rows = filtered.map(function(entry) {
	    return '<div class="data-row credit-grid"><div class="data-cell identity"><span class="record-title">' + esc(entry.email) + '</span></div><div class="data-cell" data-label="Credits"><span class="badge badge-green">' + (Number(entry.credits) || 0) + '</span></div></div>';
	  }).join('');
	  document.getElementById('creditsTable').innerHTML = filtered.length ? '<div class="data-list">' + head + rows + '</div>' : emptyList('No credit records found', 'Try another search term.');
	  renderAdminIcons();
	}

	function addCredits() {
	  var email = document.getElementById('creditEmailInput').value.trim();
	  var amount = document.getElementById('creditAmountInput').value.trim();
	  if (!email || !amount) return toast('Enter email and amount', 'error');
	  var parsed = parseInt(amount, 10);
	  if (isNaN(parsed) || parsed <= 0) return toast('Invalid amount', 'error');
	  adminApi('add-credits', { email: email, amount: parsed }).then(function(d){
	    toast('Added ' + parsed + ' credits to ' + d.email + ' (now: ' + d.credits + ')');
	    document.getElementById('creditEmailInput').value = '';
	    document.getElementById('creditAmountInput').value = '';
	    loadCredits();
	  }).catch(function(e){ toast(e.message, 'error'); });
	}
	</script>
	<script src="https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js"></script>
	<script>renderAdminIcons();</script>
	</body>
	</html>`;

	// ============================================================
	// Seller Dashboard HTML (shop.trueteamcommunity.dpdns.org)
	// ============================================================
	const SHOP_HTML = `<!DOCTYPE html>
	<html lang="vi">
	<head>
	<meta charset="UTF-8"/>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
	<title>TrueTeam Shop</title>
	<meta name="theme-color" content="#0e0c12"/>
	<meta name="description" content="TrueTeam Shop — Sản phẩm & dịch vụ chất lượng"/>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
	<style>
	*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
	:root{
	  --bg:#0e0c12;--bg2:#131117;--surface:#19171f;--surface2:#211e29;--surface3:#2a2634;
	  --border:#302c3a;--border2:#443d50;--border3:#5b526a;
	  --text:#f5f2fa;--text2:#b6afc2;--text3:#7f778d;
	  --accent:#b895ff;--accent2:#9f7aef;--accent3:#dccfff;
	  --accent-glow:rgba(184,149,255,0.17);
	  --blue:#75d5ff;--blue-glow:rgba(117,213,255,0.16);
	  --red:#ef4444;--yellow:#eab308;--green:#22c55e;
	  --orange:#f97316;--purple:#b895ff;
	  --radius:6px;--radius-lg:8px;--radius-xl:8px;
	  --font-sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
	  --font-mono:'JetBrains Mono',Consolas,monospace;
	  --banner-h:40px;
	  --safe-bottom:env(safe-area-inset-bottom,0px);
	}
	html{scroll-behavior:smooth}
	body{font-family:var(--font-sans);background:var(--bg);color:var(--text);min-height:100vh;min-height:100dvh;-webkit-font-smoothing:antialiased;letter-spacing:0;padding-bottom:calc(20px + var(--safe-bottom));}
	body.banner-on{padding-top:var(--banner-h)}
	::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
	.icon{width:16px;height:16px;stroke-width:1.8;flex:0 0 auto}.icon-sm{width:14px;height:14px}

	/* ── Banner Marquee ── */
	.shop-banner{position:fixed;top:0;left:0;right:0;z-index:100;height:var(--banner-h);overflow:hidden;background:#e8ddff;border-bottom:1px solid #c9b4f5;display:flex;align-items:center;cursor:pointer;user-select:none;}
	.banner-track{display:inline-flex;white-space:nowrap;animation:marquee 25s linear infinite;}
	.shop-banner:hover .banner-track{animation-play-state:paused;}
	.banner-track span{display:inline-block;padding:0 60px;font-size:0.78rem;font-weight:700;color:#241b33;letter-spacing:0;}
	@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}

	/* ── Layout ── */
	.container{max-width:1100px;margin:0 auto;padding:20px 16px;}
	@media(min-width:640px){.container{padding:28px 24px}}

	/* ── Top Bar ── */
	.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 0 20px;animation:fadeUp .5s ease both;}
	.topbar-left{display:flex;align-items:center;gap:12px;}
	.logo-img{width:42px;height:42px;border-radius:var(--radius-lg);object-fit:cover;border:1px solid var(--border2);background:var(--surface);}
	.logo-placeholder{width:42px;height:42px;border-radius:var(--radius-lg);background:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.1rem;color:#1d122c;box-shadow:0 2px 12px var(--accent-glow);}
	.topbar-title{font-size:1.2rem;font-weight:700;color:#fff;letter-spacing:0;}
	.topbar-sub{font-size:0.7rem;color:var(--text3);margin-top:1px;}
	.btn-seller{padding:8px 14px;border-radius:var(--radius);background:transparent;border:1px solid var(--border2);color:var(--text2);font-size:0.76rem;font-weight:600;cursor:pointer;transition:all .15s;font-family:var(--font-sans);display:flex;align-items:center;gap:7px;}
	.btn-seller:hover{border-color:var(--accent);color:var(--accent3);background:rgba(184,149,255,0.08);}

	/* ── Hero Section ── */
	.hero{position:relative;min-height:270px;margin:4px 0 24px;padding:28px;overflow:hidden;border:1px solid var(--border2);border-radius:8px;background-image:linear-gradient(90deg,rgba(14,12,18,.18),rgba(14,12,18,.9)),url('/assets/community-art.webp');background-size:cover;background-position:center 28%;text-align:left;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-end;animation:fadeUp .6s ease both .1s;}
	.hero-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:4px;background:rgba(14,12,18,.72);border:1px solid rgba(220,207,255,.3);font-size:0.66rem;font-weight:600;color:var(--accent3);margin-bottom:12px;}
	.hero h1{max-width:540px;font-size:1.65rem;font-weight:800;color:#fff;letter-spacing:0;line-height:1.3;margin-bottom:8px;}
	.hero h1 em{font-style:normal;color:var(--accent);}
	.hero p{font-size:0.82rem;color:#d8d1e1;max-width:480px;margin:0;}

	/* ── Category Tabs ── */
	.cat-tabs{display:flex;gap:8px;padding:4px 0 20px;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none;}
	.cat-tabs::-webkit-scrollbar{display:none;}
	.cat-tab{padding:7px 16px;border-radius:9999px;background:var(--surface);border:1px solid var(--border);color:var(--text2);font-size:0.75rem;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .15s;font-family:var(--font-sans);}
	.cat-tab:hover{border-color:var(--border3);color:var(--text);}
	.cat-tab.active{background:var(--accent);color:#1d122c;border-color:var(--accent);box-shadow:0 2px 10px var(--accent-glow);}
	.shop-tools{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px;}
	.product-search{width:min(320px,100%);height:38px;padding:0 11px;border:1px solid var(--border);border-radius:6px;background:var(--surface);display:flex;align-items:center;gap:8px;}
	.product-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);}
	.product-search input{height:36px;padding:0;margin:0;border:0;background:transparent;box-shadow:none;font-size:.75rem;}.product-search input:focus{border:0;box-shadow:none;}

	/* ── Product Grid ── */
	.section-title{font-size:0.85rem;font-weight:700;color:var(--text);margin-bottom:16px;display:flex;align-items:center;gap:8px;}
	.section-title .count{font-size:0.7rem;color:var(--text3);font-weight:500;}
	.product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-bottom:32px;}
	@media(max-width:540px){.product-grid{grid-template-columns:1fr 1fr;gap:10px;}}

	.product-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;transition:all .2s;cursor:default;animation:fadeUp .5s ease both;}
	.product-card:hover{border-color:var(--border3);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.3);}
	.product-img{width:100%;aspect-ratio:1;object-fit:cover;background:var(--surface2);display:block;}
	.product-img-placeholder{width:100%;aspect-ratio:1;background:linear-gradient(135deg,var(--surface2),var(--surface3));display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--text3);}
	.product-info{padding:12px;}
	.product-name{font-size:0.82rem;font-weight:600;color:var(--text);margin-bottom:4px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
	.product-desc{font-size:0.7rem;color:var(--text3);margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;}
	.product-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}
	.product-price{font-size:0.9rem;font-weight:700;color:var(--accent);}
	.product-price.free{color:var(--blue);}
	.product-cat{max-width:100%;font-size:0.6rem;padding:2px 8px;border-radius:4px;background:var(--surface3);color:var(--text3);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

	/* ── QR / Payment Section ── */
	.payment-section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-xl);padding:24px;margin-bottom:32px;animation:fadeUp .5s ease both .3s;}
	.payment-inner{display:flex;flex-wrap:wrap;gap:24px;align-items:center;}
	.qr-box{flex-shrink:0;text-align:center;}
	.qr-box img{width:160px;height:160px;border-radius:var(--radius-lg);border:2px solid var(--border2);background:#fff;padding:8px;object-fit:contain;}
	.qr-box .qr-label{font-size:0.7rem;color:var(--text3);margin-top:8px;}
	.bank-info{flex:1;min-width:200px;}
	.bank-info h3{font-size:0.85rem;font-weight:700;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:6px;}
	.bank-row{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);border-radius:var(--radius);margin-bottom:6px;}
	.bank-row .label{font-size:0.7rem;color:var(--text3);min-width:80px;}
	.bank-row .value{flex:1;min-width:0;font-size:0.82rem;color:var(--text);font-weight:500;font-family:var(--font-mono);overflow-wrap:anywhere;}
	.copy-btn{padding:3px 8px;border-radius:var(--radius);background:transparent;border:1px solid var(--border2);color:var(--text2);font-size:0.65rem;font-weight:600;cursor:pointer;transition:all .12s;margin-left:auto;}
	.copy-btn:hover{border-color:var(--accent);color:var(--accent);}

	/* ── Empty State ── */
	.empty-state{text-align:center;padding:48px 20px;color:var(--text3);}
	.empty-state .icon{font-size:2.5rem;margin-bottom:12px;}
	.empty-state p{font-size:0.82rem;}

	/* ── Seller Workspace ── */
	body.modal-open{overflow:hidden;}
	.modal-overlay{position:fixed;inset:0;z-index:200;background:rgba(4,3,7,.78);backdrop-filter:blur(7px);display:none;align-items:center;justify-content:center;padding:16px;}
	.modal-overlay.open{display:flex;}
	.modal{width:min(980px,100%);height:min(720px,calc(100dvh - 32px));border:1px solid var(--border2);border-radius:8px;background:var(--surface);overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr);box-shadow:0 24px 70px rgba(0,0,0,.55);animation:modalIn .2s ease;}
	.modal.auth-mode{width:min(430px,100%);height:auto;max-height:calc(100dvh - 32px);}
	@keyframes modalIn{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
	.modal-header{min-height:64px;padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;}
	.modal-title-wrap{min-width:0;display:flex;align-items:center;gap:10px;}.modal-title-icon{width:34px;height:34px;border:1px solid rgba(184,149,255,.3);border-radius:6px;background:rgba(184,149,255,.1);color:var(--accent3);display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
	.modal-header h2{font-size:.88rem;font-weight:700;color:#fff;}.modal-header p{margin-top:3px;color:var(--text3);font-size:.62rem;}
	.modal-close{width:34px;height:34px;border-radius:5px;background:transparent;border:1px solid var(--border2);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .12s;}
	.modal-close:hover{border-color:var(--red);color:var(--red);}
	.seller-login{padding:26px;}.seller-login-copy{margin-bottom:20px;}.seller-login-copy h3{font-size:1rem;}.seller-login-copy p{margin-top:6px;color:var(--text3);font-size:.7rem;line-height:1.5;}
	#sellerDashboard{min-height:0;display:grid;grid-template-columns:205px minmax(0,1fr);}
	.seller-sidebar{padding:14px 12px;border-right:1px solid var(--border);background:var(--bg2);display:flex;flex-direction:column;gap:6px;}
	.seller-identity{padding:10px;margin-bottom:4px;border:1px solid var(--border);border-radius:6px;background:var(--surface);}.seller-identity strong{display:block;font-size:.72rem;}.seller-identity span{display:block;margin-top:4px;color:var(--accent3);font:600 .57rem var(--font-mono);text-transform:uppercase;}
	.seller-tab{width:100%;min-height:40px;padding:0 10px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--text3);display:flex;align-items:center;gap:9px;font:500 .72rem var(--font-sans);cursor:pointer;text-align:left;}.seller-tab:hover{color:var(--text2);background:rgba(255,255,255,.025)}.seller-tab.active{color:var(--text);border-color:rgba(184,149,255,.28);background:rgba(184,149,255,.11)}
	.seller-sidebar-spacer{flex:1;}.seller-logout{color:var(--red);}
	.seller-content{min-width:0;min-height:0;overflow-y:auto;padding:20px;}
	.seller-panel-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px;}.seller-panel-header h3{font-size:.9rem;}.seller-panel-header p{margin-top:5px;color:var(--text3);font-size:.68rem;line-height:1.5;}
	.seller-section{margin:0;}.field-group{margin-bottom:12px;}.field-label{font-size:.66rem;color:var(--text2);display:block;margin-bottom:6px;}
	input,select,textarea{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--font-sans);font-size:.8rem;outline:none;transition:all .12s;}
	input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow);}
	textarea{resize:vertical;min-height:76px;}
	.btn{min-height:36px;padding:8px 14px;border:1px solid transparent;border-radius:5px;cursor:pointer;font-weight:600;font-size:.72rem;font-family:var(--font-sans);transition:all .12s;display:inline-flex;align-items:center;justify-content:center;gap:6px;}
	.btn:active{transform:scale(.98);}.btn-primary{background:var(--accent);color:#1d122c;border-color:var(--accent);}.btn-primary:hover{background:var(--accent2);box-shadow:0 2px 12px var(--accent-glow);}.btn-outline{background:transparent;color:var(--text2);border-color:var(--border2);}.btn-outline:hover{border-color:var(--accent);color:var(--accent);}.btn-red{background:transparent;color:var(--red);border-color:var(--border2);}.btn-red:hover{border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.06)}.btn-sm{min-height:32px;padding:5px 10px;font-size:.68rem;}
	.hidden{display:none!important}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}.settings-grid .wide{grid-column:1/-1;}.seller-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);}
	.asset-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}.asset-card{min-width:0;padding:14px;border:1px solid var(--border);border-radius:7px;background:var(--bg2);}.asset-card h4{font-size:.76rem;}.asset-card p{margin-top:5px;color:var(--text3);font-size:.62rem;line-height:1.5;}.asset-preview{height:150px;margin:14px 0;border:1px dashed var(--border2);border-radius:6px;background:var(--surface);display:flex;align-items:center;justify-content:center;overflow:hidden;color:var(--text3);}.asset-preview img{max-width:100%;max-height:100%;object-fit:contain;}.file-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;}.file-picker{width:100%;min-height:40px;padding:0 10px;border:1px solid var(--border2);border-radius:5px;background:var(--surface);color:var(--text2);display:flex;align-items:center;gap:8px;font-size:.68rem;cursor:pointer;}.file-picker span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.asset-card .btn{width:100%;margin-top:8px;}
	.product-workspace{display:grid;grid-template-columns:310px minmax(0,1fr);gap:18px;align-items:start;}.product-form-panel{padding-right:18px;border-right:1px solid var(--border);}.seller-list-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}.seller-list-toolbar strong{font-size:.76rem;}.seller-list-toolbar .product-search{width:min(260px,100%);margin:0;}
	.seller-product-list{display:flex;flex-direction:column;gap:7px;}.seller-product-item{display:flex;align-items:center;gap:10px;padding:9px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);}.seller-product-item img,.seller-product-placeholder{width:48px;height:48px;border-radius:5px;object-fit:cover;background:var(--surface2);display:flex;align-items:center;justify-content:center;flex:0 0 auto;}.seller-product-item .sp-info{flex:1;min-width:0;}.seller-product-item .sp-name{font-size:.72rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.seller-product-item .sp-meta{margin-top:4px;color:var(--text3);font-size:.61rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.seller-product-item .sp-price{color:var(--accent3);font-weight:600;}.seller-delete{width:34px;height:34px;padding:0;flex:0 0 auto;}.seller-empty{padding:42px 16px;text-align:center;color:var(--text3);font-size:.7rem;}

	/* ── Toast ── */
	.toast-box{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;width:92%;max-width:360px;}
	.toast{padding:10px 16px;border-radius:var(--radius);margin-bottom:6px;font-size:0.78rem;font-weight:500;animation:slideUp .25s ease;text-align:center;border-left:3px solid var(--accent);background:var(--surface);box-shadow:0 4px 16px rgba(0,0,0,0.3);}
	.toast-err{border-left-color:var(--red);}
	@keyframes slideUp{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
	@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}

	/* ── Footer ── */
	.footer{text-align:center;padding:20px 0;color:var(--text3);font-size:0.7rem;border-top:1px solid var(--border);margin-top:20px;}
	.footer a{color:var(--accent);text-decoration:none;}
	button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
	button:disabled{opacity:.45;pointer-events:none;}
	@media(max-width:760px){
	  #sellerDashboard{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);}.seller-sidebar{padding:8px 10px;border-right:0;border-bottom:1px solid var(--border);display:flex;flex-direction:row;overflow-x:auto;scrollbar-width:none}.seller-sidebar::-webkit-scrollbar{display:none}.seller-identity,.seller-sidebar-spacer{display:none}.seller-tab{min-width:120px;width:auto;flex:0 0 auto}.seller-tab.seller-logout{min-width:44px;font-size:0}.seller-content{padding:16px}.product-workspace{grid-template-columns:1fr}.product-form-panel{padding:0 0 18px;border-right:0;border-bottom:1px solid var(--border)}
	}
	@media(max-width:540px){
	  .hero{min-height:220px;padding:20px;background-position:42% 28%;}
	  .hero h1{font-size:1.35rem;}
	  .payment-inner{align-items:flex-start;}
	  .bank-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;}
	  .shop-tools{align-items:stretch;flex-direction:column}.product-search{width:100%}.modal-overlay{padding:0;align-items:flex-end}.modal:not(.auth-mode){width:100%;height:100dvh;border-radius:0;border-left:0;border-right:0}.modal.auth-mode{width:calc(100% - 24px);margin:12px}.modal-header{padding:10px 14px}.seller-content{padding:14px}.settings-grid,.asset-grid{grid-template-columns:1fr}.settings-grid .wide{grid-column:auto}.seller-panel-header{flex-direction:column}.seller-actions{justify-content:stretch}.seller-actions .btn{flex:1}.seller-list-toolbar{align-items:stretch;flex-direction:column}.seller-list-toolbar .product-search{width:100%}
	}
	@media(max-width:380px){.product-grid{grid-template-columns:1fr;}.topbar-title{font-size:1rem;}.btn-seller{padding:8px 10px;}}
	@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;}}
	</style>
	</head>
	<body id="shopBody">
	<div class="toast-box" id="toastBox"></div>

	<!-- Banner -->
	<div class="shop-banner hidden" id="shopBanner">
	  <div class="banner-track" id="bannerTrack"></div>
	</div>

	<div class="container">
	  <!-- Top Bar -->
	  <div class="topbar">
	    <div class="topbar-left">
	      <div class="logo-placeholder" id="logoDisplay">T</div>
	      <div>
	        <div class="topbar-title">TrueTeam Shop</div>
	        <div class="topbar-sub">Chất lượng — Uy tín — Tận tâm</div>
	      </div>
	    </div>
	    <button class="btn-seller" id="sellerBtn" onclick="openSellerModal()"><i data-lucide="store" class="icon icon-sm" aria-hidden="true">S</i>Manage shop</button>
	  </div>

	  <!-- Hero -->
	  <div class="hero" id="heroSection">
	    <div class="hero-badge"><i data-lucide="sparkles" class="icon icon-sm" aria-hidden="true">*</i>TrueTeam storefront</div>
	    <h1 id="heroTitle">Sản phẩm <em>chất lượng</em> dành cho bạn</h1>
	    <p id="heroDesc">Khám phá các sản phẩm và dịch vụ tốt nhất từ TrueTeam Community</p>
	  </div>

	  <div class="shop-tools">
	    <div class="cat-tabs" id="catTabs"><button class="cat-tab active" data-cat="all" onclick="filterCategory('all',this)">Tất cả</button></div>
	    <label class="product-search" for="productSearchInput"><i data-lucide="search" class="icon icon-sm" aria-hidden="true">?</i><input type="search" id="productSearchInput" placeholder="Tìm sản phẩm" autocomplete="off" oninput="searchProducts(this.value)" /></label>
	  </div>

	  <div class="section-title">Sản phẩm <span class="count" id="productCount"></span></div>
	  <div class="product-grid" id="productGrid"></div>

	  <!-- Empty state -->
	  <div class="empty-state hidden" id="emptyState">
	    <i data-lucide="package-search" class="icon" aria-hidden="true">0</i>
	    <p id="emptyStateText">Chưa có sản phẩm nào. Quay lại sau nhé!</p>
	  </div>

	  <!-- Payment Section -->
	  <div class="payment-section hidden" id="paymentSection">
	    <div class="payment-inner">
	      <div class="qr-box" id="qrBox">
	        <div style="width:160px;height:160px;border-radius:var(--radius-lg);border:2px dashed var(--border2);display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:0.75rem;">QR chưa có</div>
	        <div class="qr-label">Quét QR để thanh toán</div>
	      </div>
	      <div class="bank-info">
	        <h3><i data-lucide="landmark" class="icon icon-sm" aria-hidden="true">B</i>Thông tin thanh toán</h3>
	        <div class="bank-row"><span class="label">Ngân hàng</span><span class="value" id="bankName">—</span><button class="copy-btn" onclick="copyText('bankName')">Copy</button></div>
	        <div class="bank-row"><span class="label">Số TK</span><span class="value" id="bankAccount">—</span><button class="copy-btn" onclick="copyText('bankAccount')">Copy</button></div>
	        <div class="bank-row"><span class="label">Chủ TK</span><span class="value" id="bankHolder">—</span><button class="copy-btn" onclick="copyText('bankHolder')">Copy</button></div>
	      </div>
    </div>
	  </div>

	  <div class="footer">
	    <p>© 2026 <a href="https://trueteamcommunity.dpdns.org">TrueTeam Community</a>. All rights reserved.</p>
	  </div>
	</div>

	<!-- Seller Modal -->
	<div class="modal-overlay" id="sellerModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
	  <div class="modal auth-mode" id="sellerPanel">
	    <div class="modal-header">
	      <div class="modal-title-wrap"><span class="modal-title-icon"><i data-lucide="store" class="icon" aria-hidden="true">S</i></span><div><h2 id="modalTitle">Seller access</h2><p id="modalSubtitle">Manage the TrueTeam storefront</p></div></div>
      <button type="button" class="modal-close" onclick="closeSellerModal()" aria-label="Close seller workspace"><i data-lucide="x" class="icon" aria-hidden="true">x</i></button>
	    </div>

	    <form id="sellerLoginForm" class="seller-login" onsubmit="event.preventDefault();doSellerLogin();">
	      <div class="seller-login-copy"><h3>Sign in to your workspace</h3><p>Seller, Admin, and Owner accounts can manage the shop.</p></div>
	      <div class="field-group">
	        <label class="field-label" for="sellerEmail">Email address</label>
	        <input type="email" id="sellerEmail" placeholder="seller@example.com" autocomplete="email" required />
	      </div>
	      <div class="field-group">
	        <label class="field-label" for="sellerPass">Password</label>
        <input type="password" id="sellerPass" placeholder="Enter password" autocomplete="current-password" required />
	      </div>
	      <button type="submit" class="btn btn-primary" id="sellerLoginBtn" style="width:100%"><i data-lucide="log-in" class="icon icon-sm" aria-hidden="true">&gt;</i>Sign in</button>
	    </form>

	    <div id="sellerDashboard" class="hidden">
	      <aside class="seller-sidebar" role="tablist" aria-label="Seller workspace">
	        <div class="seller-identity"><strong id="sellerIdentityName">Store manager</strong><span id="sellerIdentityRole">Authenticated</span></div>
	        <button type="button" class="seller-tab active" data-seller-tab="settings" onclick="switchSellerTab('settings',this)"><i data-lucide="sliders-horizontal" class="icon" aria-hidden="true">S</i>Shop settings</button>
	        <button type="button" class="seller-tab" data-seller-tab="assets" onclick="switchSellerTab('assets',this)"><i data-lucide="images" class="icon" aria-hidden="true">A</i>Brand assets</button>
	        <button type="button" class="seller-tab" data-seller-tab="products" onclick="switchSellerTab('products',this)"><i data-lucide="package" class="icon" aria-hidden="true">P</i>Products</button>
	        <div class="seller-sidebar-spacer"></div>
	        <button type="button" class="seller-tab seller-logout" onclick="doSellerLogout()"><i data-lucide="log-out" class="icon" aria-hidden="true">x</i>Sign out</button>
	      </aside>

	      <div class="seller-content">
	        <section class="seller-panel" id="seller-tab-settings">
	          <header class="seller-panel-header"><div><h3>Shop settings</h3><p>Shared storefront banner and payment details.</p></div></header>
	          <div class="settings-grid">
	            <div class="field-group wide"><label class="field-label" for="sBannerText">Banner text</label><textarea id="sBannerText" placeholder="TrueTeam Shop — Sản phẩm chất lượng!"></textarea></div>
	            <div class="field-group"><label class="field-label" for="sBankName">Tên ngân hàng</label><input type="text" id="sBankName" placeholder="VD: MB Bank" /></div>
	            <div class="field-group"><label class="field-label" for="sBankAccount">Số tài khoản</label><input type="text" id="sBankAccount" placeholder="VD: 0123456789" /></div>
	            <div class="field-group wide"><label class="field-label" for="sBankHolder">Chủ tài khoản</label><input type="text" id="sBankHolder" placeholder="VD: NGUYEN VAN A" /></div>
	          </div>
	          <div class="seller-actions"><button type="button" class="btn btn-primary" id="sellerSettingsSaveBtn" onclick="saveSellerSettings()"><i data-lucide="save" class="icon icon-sm" aria-hidden="true">S</i>Save changes</button></div>
	        </section>

	        <section class="seller-panel hidden" id="seller-tab-assets">
	          <header class="seller-panel-header"><div><h3>Brand assets</h3><p>PNG, JPG hoặc WebP · tối đa 2 MB.</p></div></header>
	          <div class="asset-grid">
	            <article class="asset-card"><h4>Shop logo</h4><p>Square or compact image used in the storefront header.</p><div id="sLogoPreview" class="asset-preview"><span id="sLogoEmpty">No logo uploaded</span><img id="sLogoImg" class="hidden" alt="Shop logo preview" /></div><input class="file-input" type="file" id="sLogoFile" accept="image/png,image/jpeg,image/webp" onchange="updateSellerFileLabel('sLogoFile','sLogoFileName')" /><label class="file-picker" for="sLogoFile"><i data-lucide="image-up" class="icon icon-sm" aria-hidden="true">+</i><span id="sLogoFileName">Choose image</span></label><button type="button" class="btn btn-primary btn-sm" id="sellerLogoUploadBtn" onclick="uploadSellerLogo()">Upload logo</button></article>
	            <article class="asset-card"><h4>Payment QR</h4><p>Clear QR image shown with payment information.</p><div id="sQrPreview" class="asset-preview"><span id="sQrEmpty">No QR uploaded</span><img id="sQrImg" class="hidden" alt="Payment QR preview" /></div><input class="file-input" type="file" id="sQrFile" accept="image/png,image/jpeg,image/webp" onchange="updateSellerFileLabel('sQrFile','sQrFileName')" /><label class="file-picker" for="sQrFile"><i data-lucide="scan-line" class="icon icon-sm" aria-hidden="true">+</i><span id="sQrFileName">Choose image</span></label><button type="button" class="btn btn-primary btn-sm" id="sellerQrUploadBtn" onclick="uploadSellerQr()">Upload QR</button></article>
	          </div>
	        </section>

	        <section class="seller-panel hidden" id="seller-tab-products">
	          <header class="seller-panel-header"><div><h3>Products</h3><p>Create listings and manage products owned by this account.</p></div></header>
	          <div class="product-workspace">
	            <form class="product-form-panel" onsubmit="event.preventDefault();addSellerProduct();">
	              <div class="field-group"><label class="field-label" for="sProductName">Tên sản phẩm</label><input type="text" id="sProductName" placeholder="Tên sản phẩm" required /></div>
	              <div class="field-group"><label class="field-label" for="sProductDesc">Mô tả</label><textarea id="sProductDesc" placeholder="Mô tả ngắn..."></textarea></div>
	              <div class="settings-grid"><div class="field-group"><label class="field-label" for="sProductPrice">Giá (đ)</label><input type="number" min="0" id="sProductPrice" placeholder="0" /></div><div class="field-group"><label class="field-label" for="sProductCat">Danh mục</label><input type="text" id="sProductCat" placeholder="VPS, Tool..." /></div></div>
	              <div class="field-group"><label class="field-label">Hình ảnh</label><input class="file-input" type="file" id="sProductImg" accept="image/png,image/jpeg,image/webp" onchange="updateSellerFileLabel('sProductImg','sProductImgFileName')" /><label class="file-picker" for="sProductImg"><i data-lucide="image-plus" class="icon icon-sm" aria-hidden="true">+</i><span id="sProductImgFileName">Optional image</span></label></div>
	              <button type="submit" class="btn btn-primary" id="sellerProductSaveBtn" style="width:100%;"><i data-lucide="plus" class="icon icon-sm" aria-hidden="true">+</i>Add product</button>
	            </form>
	            <div class="seller-inventory"><div class="seller-list-toolbar"><strong>Sản phẩm của bạn <span id="sellerProductCount"></span></strong><label class="product-search" for="sellerProductSearch"><i data-lucide="search" class="icon icon-sm" aria-hidden="true">?</i><input type="search" id="sellerProductSearch" placeholder="Search inventory" autocomplete="off" oninput="searchSellerProducts(this.value)" /></label></div><div class="seller-product-list" id="sellerProductList"></div></div>
	          </div>
	        </section>
	      </div>
	      </div>
	    </div>
	</div>

	<script>
	/* ── State ── */
	var shopToken = localStorage.getItem('shopToken') || '';
	var allProducts = [];
	var currentCat = 'all';
	var productQuery = '';
	var sellerProducts = [];
	var sellerProductQuery = '';
	var activeSellerTab = 'settings';
	var sellerProfile = {};
	var API = '/api/';

	function renderShopIcons() {
	  if (window.lucide) window.lucide.createIcons();
	}

	/* ── Toast ── */
	function toast(msg, err) {
	  var c = document.getElementById('toastBox');
	  var t = document.createElement('div');
	  t.className = 'toast' + (err ? ' toast-err' : '');
	  t.textContent = msg;
	  c.appendChild(t);
	  setTimeout(function(){ t.remove(); }, 3000);
	}

	/* ── Fetch helper ── */
	function api(path, data, method) {
	  var opts = { method: method || 'POST', headers: {} };
	  if (data && !(data instanceof FormData)) {
	    opts.headers['Content-Type'] = 'application/json';
	    opts.body = JSON.stringify(Object.assign({}, data, shopToken ? { shopToken: shopToken } : {}));
	  } else if (data instanceof FormData) {
	    if (shopToken) opts.headers['shopToken'] = shopToken;
    opts.body = data;
	  }
	  return fetch(API + path, opts).then(function(r) {
	    var ct = r.headers.get('content-type') || '';
	    if (!ct.includes('json')) return r.text().then(function(t){ throw new Error(t || 'HTTP ' + r.status); });
	    return r.json();
	  }).then(function(j) { if (j.error) throw new Error(j.error); return j; });
	}

	/* ── Load Shop Config (public) ── */
	function loadShopConfig() {
	  fetch(API + 'config').then(function(r){ return r.json(); }).then(function(d) {
	    var banner = document.getElementById('shopBanner');
	    if (d.bannerText) {
	      var txt = d.bannerText;
	      var track = document.getElementById('bannerTrack');
	      var safeText = escHtml(txt);
	      track.innerHTML = '<span>' + safeText + '</span><span>' + safeText + '</span><span>' + safeText + '</span><span>' + safeText + '</span>';
	      banner.classList.remove('hidden');
	      document.body.classList.add('banner-on');
	    } else {
	      banner.classList.add('hidden');
	      document.body.classList.remove('banner-on');
	    }
	    var logoUrl = safeShopUrl(d.logoUrl);
	    if (logoUrl) {
	      var ld = document.getElementById('logoDisplay');
	      var nextLogoUrl = logoUrl + '?_t=' + Date.now();
	      if (ld.tagName === 'IMG') {
	        ld.src = nextLogoUrl;
	      } else {
	        ld.outerHTML = '<img class="logo-img" id="logoDisplay" src="' + escAttr(nextLogoUrl) + '" onerror="this.outerHTML=&#39;<div class=&quot;logo-placeholder&quot; id=&quot;logoDisplay&quot;>T</div>&#39;" />';
	      }
	    }
	    var qrUrl = safeShopUrl(d.qrUrl);
	    if (qrUrl) {
	      var qb = document.getElementById('qrBox');
	      qb.innerHTML = '<img src="' + escAttr(qrUrl + '?_t=' + Date.now()) + '" /><div class="qr-label">Quét QR để thanh toán</div>';
	      document.getElementById('paymentSection').classList.remove('hidden');
	    }
	    if (d.bankName) document.getElementById('bankName').textContent = d.bankName;
	    if (d.bankAccount) document.getElementById('bankAccount').textContent = d.bankAccount;
	    if (d.bankHolder) document.getElementById('bankHolder').textContent = d.bankHolder;
	    if (d.bankName || d.bankAccount) document.getElementById('paymentSection').classList.remove('hidden');
	  }).catch(function(){});
	}

	/* ── Load Products (public) ── */
	function loadProducts() {
	  api('products', null, 'GET').then(function(d) {
	    allProducts = d.products || [];
	    renderCategories();
	    renderProducts();
	  }).catch(function(e) {
	    document.getElementById('emptyState').classList.remove('hidden');
	  });
	}

	function renderCategories() {
	  var cats = {};
	  allProducts.forEach(function(p) {
	    var c = (p.category || 'general').toLowerCase();
	    cats[c] = (cats[c] || 0) + 1;
	  });
	  var tabs = document.getElementById('catTabs');
	  if (currentCat !== 'all' && !cats[currentCat]) currentCat = 'all';
	  tabs.innerHTML = '';
	  function addCategoryTab(value, label, count) {
	    var item = document.createElement('button');
	    item.type = 'button';
	    item.className = 'cat-tab' + (currentCat === value ? ' active' : '');
	    item.dataset.cat = value;
	    item.textContent = label + ' (' + count + ')';
	    item.addEventListener('click', function(){ filterCategory(value, item); });
	    tabs.appendChild(item);
	  }
	  addCategoryTab('all', 'Tất cả', allProducts.length);
	  Object.keys(cats).forEach(function(c) { addCategoryTab(c, c, cats[c]); });
	}

	function filterCategory(cat, el) {
	  currentCat = cat;
	  document.querySelectorAll('.cat-tab').forEach(function(t){ t.classList.remove('active'); });
	  if (el) el.classList.add('active');
	  renderProducts();
	}

	function searchProducts(value) {
	  productQuery = String(value || '').trim().toLowerCase();
	  renderProducts();
	}

	function renderProducts() {
	  var grid = document.getElementById('productGrid');
	  var empty = document.getElementById('emptyState');
	  var filtered = currentCat === 'all' ? allProducts : allProducts.filter(function(p){ return (p.category || 'general').toLowerCase() === currentCat; });
	  if (productQuery) filtered = filtered.filter(function(p) {
	    return [p.name, p.description, p.category].map(function(value){ return String(value || '').toLowerCase(); }).join(' ').includes(productQuery);
	  });
	  document.getElementById('productCount').textContent = '(' + filtered.length + ' sản phẩm)';
	  if (filtered.length === 0) {
	    grid.innerHTML = '';
	    document.getElementById('emptyStateText').textContent = allProducts.length ? 'Không tìm thấy sản phẩm phù hợp.' : 'Chưa có sản phẩm nào. Quay lại sau nhé!';
	    empty.classList.remove('hidden');
	    return;
	  }
	  empty.classList.add('hidden');
	  grid.innerHTML = filtered.map(function(p, i) {
	    var priceText = p.price > 0 ? formatPrice(p.price) : 'Miễn phí';
	    var priceClass = p.price > 0 ? '' : ' free';
	    var imageUrl = safeShopUrl(p.image_url);
	    var imgHtml = imageUrl ? '<img class="product-img" src="' + escAttr(imageUrl) + '" alt="" loading="lazy"/>' : '<div class="product-img-placeholder"><i data-lucide="package" class="icon" aria-hidden="true">P</i></div>';
	    var catText = p.category || 'general';
	    return '<div class="product-card" style="animation-delay:' + (i * 0.05) + 's">' + imgHtml + '<div class="product-info"><div class="product-name">' + escHtml(p.name) + '</div><div class="product-desc">' + escHtml(p.description || '') + '</div><div class="product-bottom"><div class="product-price' + priceClass + '">' + priceText + '</div><div class="product-cat">' + escHtml(catText) + '</div></div></div></div>';
	  }).join('');
	  renderShopIcons();
	}

	function formatPrice(n) {
	  return new Intl.NumberFormat('vi-VN').format(n) + 'đ';
	}

	function escHtml(s) {
	  var d = document.createElement('div');
	  d.textContent = s;
	  return d.innerHTML;
	}

	function escAttr(s) {
	  return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	function safeShopUrl(value) {
	  try {
	    var parsed = new URL(String(value || ''), location.origin);
	    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
	  } catch (e) {
	    return '';
	  }
	}

	function copyText(id) {
	  var el = document.getElementById(id);
	  if (!el) return;
	  navigator.clipboard.writeText(el.textContent).then(function(){ toast('Đã copy!'); }).catch(function(){});
	}

	/* ── Seller Modal ── */
	function openSellerModal() {
	  document.getElementById('sellerModal').classList.add('open');
	  document.body.classList.add('modal-open');
	  if (shopToken) {
	    showSellerDashboard();
	  } else {
	    document.getElementById('sellerPanel').classList.add('auth-mode');
	    document.getElementById('sellerLoginForm').classList.remove('hidden');
	    document.getElementById('sellerDashboard').classList.add('hidden');
	    document.getElementById('modalTitle').textContent = 'Seller access';
	    document.getElementById('modalSubtitle').textContent = 'Manage the TrueTeam storefront';
	  }
	  renderShopIcons();
	}

	function closeSellerModal() {
	  document.getElementById('sellerModal').classList.remove('open');
	  document.body.classList.remove('modal-open');
	}

	function doSellerLogin() {
	  var email = document.getElementById('sellerEmail').value.trim();
	  var pass = document.getElementById('sellerPass').value;
	  if (!email || !pass) return toast('Nhập email và mật khẩu', true);
	  setSellerLoading('sellerLoginBtn', true, 'Signing in...');
	  api('login', { email: email, password: pass }).then(function(d) {
	    shopToken = d.shopToken;
	    sellerProfile = d.profile || d;
	    localStorage.setItem('shopToken', shopToken);
	    showSellerDashboard();
	    toast('Đăng nhập thành công!');
	  }).catch(function(e) { toast(e.message, true); }).finally(function(){ setSellerLoading('sellerLoginBtn', false); });
	}

	function showSellerDashboard() {
	  document.getElementById('sellerPanel').classList.remove('auth-mode');
	  document.getElementById('sellerLoginForm').classList.add('hidden');
	  document.getElementById('sellerDashboard').classList.remove('hidden');
	  document.getElementById('modalTitle').textContent = 'Seller workspace';
	  document.getElementById('modalSubtitle').textContent = 'Settings, brand assets, and inventory';
	  document.getElementById('sellerIdentityName').textContent = sellerProfile.username || sellerProfile.email || 'Store manager';
	  document.getElementById('sellerIdentityRole').textContent = sellerProfile.role || 'Authenticated';
	  sellerProducts = [];
	  sellerProductQuery = '';
	  document.getElementById('sellerProductSearch').value = '';
	  renderSellerProducts();
	  var firstTab = document.querySelector('[data-seller-tab="settings"]');
	  switchSellerTab(activeSellerTab || 'settings', document.querySelector('[data-seller-tab="' + (activeSellerTab || 'settings') + '"]') || firstTab);
	  loadSellerSettings();
	  loadSellerProducts();
	  renderShopIcons();
	}

	function doSellerLogout() {
	  var logoutRequest = shopToken ? api('logout', {}) : Promise.resolve();
	  shopToken = '';
	  sellerProfile = {};
	  sellerProducts = [];
	  sellerProductQuery = '';
	  localStorage.removeItem('shopToken');
	  document.getElementById('sellerPanel').classList.add('auth-mode');
	  document.getElementById('sellerLoginForm').classList.remove('hidden');
	  document.getElementById('sellerDashboard').classList.add('hidden');
	  document.getElementById('sellerPass').value = '';
	  document.getElementById('sellerProductSearch').value = '';
	  renderSellerProducts();
	  document.getElementById('modalTitle').textContent = 'Seller access';
	  document.getElementById('modalSubtitle').textContent = 'Manage the TrueTeam storefront';
	  toast('Đã đăng xuất');
	  logoutRequest.catch(function(){});
	  renderShopIcons();
	}

	function switchSellerTab(name, button) {
	  activeSellerTab = name;
	  ['settings','assets','products'].forEach(function(tab) {
	    document.getElementById('seller-tab-' + tab).classList.toggle('hidden', tab !== name);
	  });
	  document.querySelectorAll('[data-seller-tab]').forEach(function(tab) { tab.classList.toggle('active', tab.dataset.sellerTab === name); });
	  if (button) button.classList.add('active');
	  renderShopIcons();
	}

	function setSellerLoading(id, loading, busyText) {
	  var button = document.getElementById(id);
	  if (!button) return;
	  if (!button.dataset.defaultHtml) button.dataset.defaultHtml = button.innerHTML;
	  button.disabled = loading;
	  button.innerHTML = loading ? (busyText || 'Working...') : button.dataset.defaultHtml;
	  renderShopIcons();
	}

	function validateSellerImage(file) {
	  if (!file) return false;
	  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) { toast('Chỉ hỗ trợ PNG, JPG hoặc WebP', true); return false; }
	  if (file.size > 2 * 1024 * 1024) { toast('Ảnh tối đa 2 MB', true); return false; }
	  return true;
	}

	function updateSellerFileLabel(inputId, labelId) {
	  var input = document.getElementById(inputId);
	  var file = input.files && input.files[0];
	  document.getElementById(labelId).textContent = file ? file.name : 'Choose image';
	  if (!file || !validateSellerImage(file)) {
	    if (file) input.value = '';
	    document.getElementById(labelId).textContent = inputId === 'sProductImg' ? 'Optional image' : 'Choose image';
	    return;
	  }
	  var map = { sLogoFile: ['sLogoImg','sLogoEmpty'], sQrFile: ['sQrImg','sQrEmpty'] };
	  if (map[inputId]) {
	    var image = document.getElementById(map[inputId][0]);
	    var previewUrl = URL.createObjectURL(file);
	    image.onload = function(){ URL.revokeObjectURL(previewUrl); image.onload = null; };
	    image.src = previewUrl;
	    image.classList.remove('hidden');
	    document.getElementById(map[inputId][1]).classList.add('hidden');
	  }
	}

	/* ── Seller: Load Settings ── */
	function loadSellerSettings() {
	  api('config', {}).then(function(d) {
	    if (d.profile) {
	      sellerProfile = d.profile;
	      document.getElementById('sellerIdentityName').textContent = sellerProfile.username || sellerProfile.email || 'Store manager';
	      document.getElementById('sellerIdentityRole').textContent = sellerProfile.role || 'Authenticated';
	    }
	    document.getElementById('sBannerText').value = d.bannerText || '';
	    document.getElementById('sBankName').value = d.bankName || '';
	    document.getElementById('sBankAccount').value = d.bankAccount || '';
	    document.getElementById('sBankHolder').value = d.bankHolder || '';
	    if (d.hasLogo) {
	      document.getElementById('sLogoImg').src = '/r2/shop-logo.png?_t=' + Date.now();
	      document.getElementById('sLogoImg').classList.remove('hidden');
	      document.getElementById('sLogoEmpty').classList.add('hidden');
	    }
	    if (d.hasQr) {
	      document.getElementById('sQrImg').src = '/r2/shop-qr.png?_t=' + Date.now();
	      document.getElementById('sQrImg').classList.remove('hidden');
	      document.getElementById('sQrEmpty').classList.add('hidden');
	    }
	  }).catch(function(e) { toast(e.message, true); });
	}

	function saveSellerSettings() {
	  setSellerLoading('sellerSettingsSaveBtn', true, 'Saving...');
	  api('save-bank-info', {
	    bannerText: document.getElementById('sBannerText').value.trim(),
	    bankName: document.getElementById('sBankName').value.trim(),
	    bankAccount: document.getElementById('sBankAccount').value.trim(),
	    bankHolder: document.getElementById('sBankHolder').value.trim(),
	  }).then(function() {
	    toast('Đã lưu cài đặt!');
	    loadShopConfig();
	  }).catch(function(e) { toast(e.message, true); }).finally(function(){ setSellerLoading('sellerSettingsSaveBtn', false); });
	}

	/* ── Seller: Upload Logo ── */
	function uploadSellerLogo() {
	  var file = document.getElementById('sLogoFile').files[0];
	  if (!file) return toast('Chọn file logo', true);
	  if (!validateSellerImage(file)) return;
	  setSellerLoading('sellerLogoUploadBtn', true, 'Uploading...');
	  var fd = new FormData(); fd.append('file', file);
	  fetch(API + 'upload-logo', { method: 'POST', headers: { shopToken: shopToken }, body: fd })
	  .then(function(r) { return r.json(); }).then(function(j) {
	    if (j.error) throw new Error(j.error);
	    toast('Logo đã upload!');
	    document.getElementById('sLogoFile').value = '';
	    document.getElementById('sLogoFileName').textContent = 'Choose image';
	    loadSellerSettings();
	    loadShopConfig();
	  }).catch(function(e) { toast(e.message, true); }).finally(function(){ setSellerLoading('sellerLogoUploadBtn', false); });
	}

	/* ── Seller: Upload QR ── */
	function uploadSellerQr() {
	  var file = document.getElementById('sQrFile').files[0];
	  if (!file) return toast('Chọn file QR', true);
	  if (!validateSellerImage(file)) return;
	  setSellerLoading('sellerQrUploadBtn', true, 'Uploading...');
	  var fd = new FormData(); fd.append('file', file);
	  fetch(API + 'upload-qr', { method: 'POST', headers: { shopToken: shopToken }, body: fd })
	  .then(function(r) { return r.json(); }).then(function(j) {
	    if (j.error) throw new Error(j.error);
	    toast('QR đã upload!');
	    document.getElementById('sQrFile').value = '';
	    document.getElementById('sQrFileName').textContent = 'Choose image';
	    loadSellerSettings();
	    loadShopConfig();
	  }).catch(function(e) { toast(e.message, true); }).finally(function(){ setSellerLoading('sellerQrUploadBtn', false); });
	}

	/* ── Seller: Add Product ── */
	function addSellerProduct() {
	  var name = document.getElementById('sProductName').value.trim();
	  var desc = document.getElementById('sProductDesc').value.trim();
	  var price = parseInt(document.getElementById('sProductPrice').value) || 0;
	  var cat = document.getElementById('sProductCat').value.trim() || 'general';
	  var file = document.getElementById('sProductImg').files[0];
	  if (!name) return toast('Nhập tên sản phẩm', true);
	  if (file && !validateSellerImage(file)) return;
	  setSellerLoading('sellerProductSaveBtn', true, 'Adding product...');
	  var imageUpload = Promise.resolve('');
	  if (file) {
	    var fd = new FormData();
	    fd.append('file', file);
	    imageUpload = fetch(API + 'upload-product-image', { method: 'POST', headers: { shopToken: shopToken }, body: fd }).then(function(r) { return r.json(); }).then(function(j) {
	      if (j.error) throw new Error(j.error);
	      return j.url || '';
	    });
	  }
	  imageUpload.then(function(imageUrl) {
	    return api('add-product', { name: name, description: desc, price: price, category: cat, imageUrl: imageUrl });
	  }).then(function() {
	    toast('Đã thêm sản phẩm!');
	    document.getElementById('sProductName').value = '';
	    document.getElementById('sProductDesc').value = '';
	    document.getElementById('sProductPrice').value = '';
	    document.getElementById('sProductCat').value = '';
	    document.getElementById('sProductImg').value = '';
	    document.getElementById('sProductImgFileName').textContent = 'Optional image';
	    loadSellerProducts();
	    loadProducts();
	  }).catch(function(e) { toast(e.message, true); }).finally(function(){ setSellerLoading('sellerProductSaveBtn', false); });
	}

	/* ── Seller: Load Products ── */
	function loadSellerProducts() {
	  api('my-products', {}).then(function(d) {
	    sellerProducts = d.products || [];
	    renderSellerProducts();
	  }).catch(function(e){
	    sellerProducts = [];
	    renderSellerProducts();
	    toast(e.message, true);
	  });
	}

	function searchSellerProducts(value) {
	  sellerProductQuery = String(value || '').trim().toLowerCase();
	  renderSellerProducts();
	}

	function renderSellerProducts() {
	  var list = document.getElementById('sellerProductList');
	  var filtered = sellerProducts.filter(function(p) {
	    if (!sellerProductQuery) return true;
	    return [p.name, p.description, p.category].map(function(value){ return String(value || '').toLowerCase(); }).join(' ').includes(sellerProductQuery);
	  });
	  document.getElementById('sellerProductCount').textContent = filtered.length === sellerProducts.length ? '(' + sellerProducts.length + ')' : '(' + filtered.length + '/' + sellerProducts.length + ')';
	  if (!filtered.length) {
	    list.innerHTML = '<div class="seller-empty">' + (sellerProducts.length ? 'Không tìm thấy sản phẩm phù hợp.' : 'Chưa có sản phẩm.') + '</div>';
	    return;
	  }
	  list.innerHTML = filtered.map(function(p) {
	    var imageUrl = safeShopUrl(p.image_url);
	    var imgTag = imageUrl ? '<img src="' + escAttr(imageUrl) + '" alt="" />' : '<div class="seller-product-placeholder"><i data-lucide="package" class="icon" aria-hidden="true">P</i></div>';
	    var id = escAttr(p.id);
	    return '<div class="seller-product-item">' + imgTag + '<div class="sp-info"><div class="sp-name">' + escHtml(p.name) + '</div><div class="sp-meta"><span class="sp-price">' + (p.price > 0 ? formatPrice(p.price) : 'Miễn phí') + '</span> · ' + escHtml(p.category || 'general') + '</div></div><button type="button" class="btn btn-red seller-delete" onclick="deleteSellerProduct(&quot;' + id + '&quot;)" aria-label="Delete ' + escAttr(p.name) + '" title="Delete product"><i data-lucide="trash-2" class="icon icon-sm" aria-hidden="true">x</i></button></div>';
	  }).join('');
	  renderShopIcons();
	}

	function deleteSellerProduct(id) {
	  if (!confirm('Xóa sản phẩm này?')) return;
	  api('delete-product', { productId: id }).then(function() {
	    toast('Đã xóa sản phẩm!');
	    loadSellerProducts();
	    loadProducts();
	  }).catch(function(e) { toast(e.message, true); });
	}

	/* ── Init ── */
	(function init() {
	  var sellerModal = document.getElementById('sellerModal');
	  sellerModal.addEventListener('click', function(event){ if (event.target === sellerModal) closeSellerModal(); });
	  document.addEventListener('keydown', function(event){ if (event.key === 'Escape') closeSellerModal(); });
	  loadShopConfig();
	  loadProducts();
	  if (shopToken) {
	    api('config', {}).then(function(d){
	      if (d.profile) sellerProfile = d.profile;
	    }).catch(function() {
      shopToken = '';
      localStorage.removeItem('shopToken');
    });
	  }
	})();
	</script>
	<script src="https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js"></script>
	<script>renderShopIcons();</script>
	</body>
	</html>`;
