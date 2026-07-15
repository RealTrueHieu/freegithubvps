// Run: node migrate.js > migrate.sql
// Then: npx wrangler d1 execute free-vps-db --remote --file=migrate.sql

const { execSync } = require('child_process');

const keys = JSON.parse(execSync('npx wrangler kv key list --binding=USERS_KV --preview false --prefix="user:"', { encoding: 'utf8', cwd: __dirname }));

const sqls = [];

for (const key of keys) {
  const email = key.name.replace('user:', '');
  try {
    const raw = execSync(`npx wrangler kv key get --binding=USERS_KV --preview false "${key.name}"`, { encoding: 'utf8', cwd: __dirname });
    const u = JSON.parse(raw);

    const esc = (s) => s ? "'" + String(s).replace(/'/g, "''") + "'" : 'NULL';

    sqls.push(`INSERT OR IGNORE INTO users (email, hash, role, github_token, owner, token_status, token_dead_reason, token_dead_at, created_at) VALUES (${esc(u.email)}, ${esc(u.hash)}, ${esc(u.role || 'user')}, ${esc(u.githubToken)}, ${esc(u.owner)}, ${esc(u.tokenStatus || 'active')}, ${esc(u.tokenDeadReason)}, ${esc(u.tokenDeadAt)}, ${u.createdAt || Date.now()});`);

    // Machines
    if (u.machines && u.machines.length > 0) {
      for (const m of u.machines) {
        sqls.push(`INSERT OR IGNORE INTO machines (id, user_email, ngrok_url, username, password, owner, repo, status, created_at) VALUES (${esc(m.id)}, ${esc(u.email)}, ${esc(m.ngrok_url)}, ${esc(m.username)}, ${esc(m.password)}, ${esc(m.owner)}, ${esc(m.repo || 'vps')}, ${esc(m.status || 'active')}, ${m.createdAt || Date.now()});`);
      }
    }
  } catch (e) {
    console.error('-- Failed to process: ' + key.name);
  }
}

console.log(sqls.join('\n'));
