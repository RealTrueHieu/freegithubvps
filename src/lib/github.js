// GitHub API helpers — tách nguyên từ src/worker.js.
import { cryptoBoxSeal, b64decode, b64encode } from './crypto.js';

export function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'FreeVPSGitHub/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function setActionsSecret(token, owner, repo, secretName, secretValue) {
  const keyRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
    { headers: ghHeaders(token) }
  );
  if (!keyRes.ok) {
    const err = await keyRes.json().catch(() => ({}));
    throw new Error('Lấy public-key thất bại: ' + (err.message || keyRes.status));
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
    throw new Error('Đặt secret ' + secretName + ' thất bại: ' + (err.message || putRes.status));
  }
}

// Gọi /user kiểm tra token còn sống không (logic giữ nguyên, message nội bộ giữ nguyên vì không user-facing trực tiếp)
export async function checkGithubToken(token) {
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
export function isSuspended(status, body) {
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
