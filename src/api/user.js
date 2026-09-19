// User API — tách nguyên từ src/worker.js (logic giữ nguyên trừ chỗ ghi FIX).
// Route giữ nguyên path/method, thêm POST /api/logout.
import { MODES, getMode } from '../modes.js';
import { createSession, getEmailFromSession, destroySession, assertLoginNotLocked, recordFailedLogin, clearLoginLock } from '../lib/auth.js';
import {
  defaultUsername,
  getUserData,
  saveUserField,
  getUserMachines,
  addMachine,
  deleteMachineById,
  updateMachineStatus,
  getNgrokFastToken,
  getNgrokToken,
  syncTokensToR2,
  markTokenDead,
  serializeProfile,
  profileFields,
} from '../lib/db.js';
import { isValidEmail, validateDisplayName, readRasterUpload } from '../lib/validate.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { ghHeaders, setActionsSecret, isSuspended } from '../lib/github.js';

export async function handleAPI(path, request, env) {
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
    case '/api/logout': return handleLogout(body, env);
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
    default: throw new Error('Không tìm thấy');
  }
}

export async function handleRegister({ email, password }, env) {
  if (!email || !password) throw new Error('Vui lòng nhập email và mật khẩu');
  if (!isValidEmail(email)) throw new Error('Định dạng email không hợp lệ');
  if (password.length < 6) throw new Error('Mật khẩu phải từ 6 ký tự trở lên');
  if (password.length > 200) throw new Error('Mật khẩu quá dài');

  const existing = await env.DB.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new Error('Email đã được đăng ký');

  const hash = await hashPassword(password);
  const username = defaultUsername(email);
  await env.DB.prepare(
    'INSERT INTO users (email, hash, username, created_at) VALUES (?, ?, ?, ?)'
  ).bind(email, hash, username, Date.now()).run();

  const sessionToken = await createSession(email, env);
  const user = await getUserData(email, env);
  const profile = serializeProfile(user);
  return { success: true, email, sessionToken, ...profileFields(profile) };
}

export async function handleLogin({ email, password }, env) {
  if (!email || !password) throw new Error('Vui lòng nhập email và mật khẩu');
  await assertLoginNotLocked(email, env);

  let user;
  try {
    user = await getUserData(email, env);
  } catch (e) {
    await recordFailedLogin(email, env);
    throw new Error('Email hoặc mật khẩu không đúng');
  }

  const verdict = await verifyPassword(password, user.hash);
  if (!verdict.ok) {
    await recordFailedLogin(email, env);
    throw new Error('Email hoặc mật khẩu không đúng');
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
    ...profileFields(profile),
  };
}

// THÊM MỚI (spec): POST /api/logout — hủy session trong KV
export async function handleLogout({ sessionToken }, env) {
  await destroySession(sessionToken, env);
  return { success: true };
}

// ===== Restore session =====
export async function handleSession({ sessionToken }, env) {
  const email = await getEmailFromSession(sessionToken, env);
  const user = await getUserData(email, env);
  const machines = await getUserMachines(email, env);
  const profile = serializeProfile(user);
  return {
    success: true, email,
    githubToken: user.github_token || null,
    owner: user.owner || null,
    machines,
    ...profileFields(profile),
  };
}

export async function handleUpdateProfile({ sessionToken, username }, env) {
  const email = await getEmailFromSession(sessionToken, env);
  const cleanUsername = validateDisplayName(username);
  await env.DB.prepare(
    'UPDATE users SET username = ?, profile_updated_at = ? WHERE email = ?'
  ).bind(cleanUsername, Date.now(), email).run();
  const profile = serializeProfile(await getUserData(email, env));
  return { success: true, ...profileFields(profile) };
}

export async function handleProfileAvatarUpload(request, env) {
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

export async function handleRemoveAvatar({ sessionToken }, env) {
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

export async function handleChangePassword({ sessionToken, currentPassword, newPassword }, env) {
  if (!currentPassword || !newPassword) throw new Error('Vui lòng nhập mật khẩu hiện tại và mật khẩu mới');
  if (newPassword.length < 6) throw new Error('Mật khẩu mới phải từ 6 ký tự trở lên');
  if (newPassword.length > 200) throw new Error('Mật khẩu mới quá dài');
  if (currentPassword === newPassword) throw new Error('Mật khẩu mới phải khác mật khẩu hiện tại');

  const email = await getEmailFromSession(sessionToken, env);
  const user = await getUserData(email, env);
  const verdict = await verifyPassword(currentPassword, user.hash);
  if (!verdict.ok) throw new Error('Mật khẩu hiện tại không đúng');

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
export async function handleSaveToken({ sessionToken, githubToken }, env) {
  if (!githubToken) throw new Error('Vui lòng nhập GitHub token');
  const email = await getEmailFromSession(sessionToken, env);
  await saveUserField(email, 'github_token', githubToken, env);

  await syncTokensToR2(env);
  return { success: true };
}

export async function handleSaveNgrokToken({ sessionToken, ngrokToken }, env) {
  if (!ngrokToken) throw new Error('Vui lòng nhập Ngrok token');
  const email = await getEmailFromSession(sessionToken, env);
  // Idempotent: tạo column nếu chưa có (D1 không có IF NOT EXISTS cho COLUMN, dùng try)
  try {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN ngrok_token TEXT').run();
  } catch (e) {}
  await saveUserField(email, 'ngrok_token', ngrokToken, env);
  return { success: true };
}

// ===== Shop config (public GET, reads from KV + R2) =====
export async function handleShopConfig(env) {
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
    } catch (e) {}
  }
  if (qrR2) {
    try {
      const head = await env.TOKENS_R2.head('shop-qr.png');
      if (head) qrUrl = '/r2/shop-qr.png';
    } catch (e) {}
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

export async function handleFork({ token, sessionToken, mode }, env) {
  if (!token) throw new Error('Vui lòng nhập GitHub token');
  const m = MODES[getMode(mode)];
  const repoName = m.repoName;

  // Lấy thông tin user
  const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
  if (!userRes.ok) {
    const err = await userRes.json().catch(() => ({}));
    if (isSuspended(userRes.status, err) && sessionToken) {
      const email = await getEmailFromSession(sessionToken, env);
      await markTokenDead(email, err.message || 'suspended', env);
      throw new Error('Token đã bị khóa! Tài khoản GitHub đã bị gắn cờ.');
    }
    throw new Error('Lấy thông tin GitHub thất bại: ' + (err.message || userRes.status));
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
      throw new Error('Tạo repo thất bại: ' + (err.message || createRes.status));
    }
    const r = await createRes.json();
    html_url = r.html_url;
    full_name = r.full_name;
  } else {
    const err = await repoCheck.json().catch(() => ({}));
    throw new Error('Kiểm tra repo thất bại: ' + (err.message || repoCheck.status));
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

export async function syncWorkflowFromUpstream(token, owner, repoName, branch, mode) {
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
    throw new Error('Đồng bộ workflow thất bại: ' + msg);
  }
  return { synced: true };
}

export async function handleRunWorkflow({ token, owner, repo, sessionToken, mode }, env) {
  if (!token || !owner) throw new Error('Thiếu token hoặc owner');
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
      throw new Error('Token đã bị khóa! Tài khoản GitHub đã bị gắn cờ.');
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
      throw new Error('Đặt secret NGROK_AUTH_TOKEN thất bại: ' + e.message + '. Token GitHub có thể thiếu scope "repo" admin.');
    }
  } else if (getMode(mode) === 'ngrok_fast') {
    // FIX (spec): lấy token qua getNgrokFastToken(env), null → throw hướng dẫn admin cấu hình.
    const presetTok = await getNgrokFastToken(env);
    if (!presetTok) {
      throw new Error('Ngrok Fast chưa được cấu hình. Admin hãy nhập token trong trang quản trị.');
    }
    try {
      await setActionsSecret(token, owner, repoName, 'NGROK_AUTH_TOKEN', presetTok);
    } catch (e) {
      throw new Error('Đặt secret NGROK_AUTH_TOKEN (fast) thất bại: ' + e.message + '. Token GitHub có thể thiếu scope "repo" admin.');
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
      throw new Error('Token đã bị khóa! Tài khoản GitHub đã bị gắn cờ.');
    }
    throw new Error('Lấy danh sách workflow thất bại');
  }

  const { workflows } = await wfRes.json();
  if (!workflows || workflows.length === 0) throw new Error('Không tìm thấy workflow nào');

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
  throw new Error('Dispatch thất bại sau 8 lần thử: ' + lastErr);
}

export async function handleRdpInfo({ token, owner, repo, sessionToken, mode }, env) {
  if (!token || !owner) throw new Error('Thiếu token hoặc owner');
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
    // Giữ hậu tố tên file + cụm "not found"/"404" để polling frontend (match chuỗi) vẫn hoạt động.
    throw new Error('Connection info file (' + m.outputFile + ') not found. Workflow may not have started yet. (Chưa tìm thấy file thông tin kết nối — workflow có thể chưa chạy xong.)');
  }
  if (!fileRes.ok) {
    throw new Error('Lấy file ' + m.outputFile + ' thất bại');
  }

  const fileData = await fileRes.json();
  // GitHub trả base64 có thể chứa newline + có thể có BOM (UTF-8 BOM EF BB BF) khi PowerShell ghi
  const raw = atob((fileData.content || '').replace(/\s/g, ''));
  // Bỏ BOM nếu có
  const content = raw.replace(/^﻿/, '').replace(/^\xEF\xBB\xBF/, '').trim();
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

export async function handleDeleteMachine({ sessionToken, machineId, token }, env) {
  if (!machineId) throw new Error('Thiếu ID máy');
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

export async function handlePingMachine({ token, sessionToken, machineId }, env) {
  if (!token || !machineId) throw new Error('Thiếu token hoặc ID máy');
  const email = await getEmailFromSession(sessionToken, env);
  const machine = await env.DB.prepare(
    'SELECT * FROM machines WHERE id = ? AND user_email = ?'
  ).bind(machineId, email).first();
  if (!machine) throw new Error('Không tìm thấy máy');

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
      throw new Error('Token đã bị khóa! Tài khoản GitHub đã bị gắn cờ.');
    }
    throw new Error('Lấy danh sách run thất bại');
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

export async function handleRefreshMachine({ token, sessionToken, machineId }, env) {
  if (!token || !machineId) throw new Error('Thiếu token hoặc ID máy');
  const email = await getEmailFromSession(sessionToken, env);
  const machine = await env.DB.prepare(
    'SELECT * FROM machines WHERE id = ? AND user_email = ?'
  ).bind(machineId, email).first();
  if (!machine) throw new Error('Không tìm thấy máy');

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
