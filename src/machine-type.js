/**
 * Machine connection-type classification.
 * Modes: vnc | bore | ngrok | ngrok_fast
 */

export const MODE_LABELS = {
  vnc: 'noVNC',
  bore: 'Bore RDP',
  ngrok: 'Ngrok RDP',
  ngrok_fast: 'Ngrok Fast',
};

export const MODE_DEFAULTS = {
  vnc: { username: '(noVNC)', password: 'hieudz' },
  bore: { username: 'admin', password: 'WindowsRDP2026@' },
  ngrok: { username: 'DucthengTechDz', password: 'W1nd0ws-P4ssw0rd-2025!' },
  ngrok_fast: { username: 'DucthengTechDz', password: 'W1nd0ws-P4ssw0rd-2025!' },
};

/**
 * Infer deploy mode from the forked repo name.
 * ngrok and ngrok_fast share repo "vps-ngrok" → both map to "ngrok".
 */
export function inferModeFromRepo(repo) {
  const repoLow = String(repo || '').toLowerCase();
  if (repoLow.includes('ngrok')) return 'ngrok';
  if (repoLow.includes('bore')) return 'bore';
  if (repoLow.includes('novnc') || repoLow.includes('vnc')) return 'vnc';
  return null;
}

/**
 * Infer mode from connection endpoint when repo is missing/ambiguous.
 */
export function inferModeFromUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return 'vnc';
  if (/ngrok\.io/i.test(value) || /\.tcp\./i.test(value)) return 'ngrok';
  if (/bore\.pub/i.test(value)) return 'bore';
  // bare host:port TCP tunnel (RDP) — default to bore-style RDP
  if (/^[^\s/]+:\d+$/.test(value)) return 'bore';
  return null;
}

/**
 * Classify a machine row for UI + server handlers.
 * Prefers repo name, then falls back to endpoint URL.
 *
 * @param {{ repo?: string, ngrok_url?: string, url?: string }} machine
 * @returns {{
 *   mode: 'vnc'|'bore'|'ngrok'|'ngrok_fast',
 *   label: string,
 *   isVnc: boolean,
 *   isBore: boolean,
 *   isNgrok: boolean,
 *   isRdp: boolean,
 *   defaults: { username: string, password: string },
 * }}
 */
export function classifyMachine(machine = {}) {
  const repoMode = inferModeFromRepo(machine.repo);
  const urlMode = inferModeFromUrl(machine.ngrok_url || machine.url);
  const mode = repoMode || urlMode || 'vnc';

  const isVnc = mode === 'vnc';
  const isBore = mode === 'bore';
  const isNgrok = mode === 'ngrok' || mode === 'ngrok_fast';

  return {
    mode,
    label: MODE_LABELS[mode] || mode,
    isVnc,
    isBore,
    isNgrok,
    isRdp: isBore || isNgrok,
    defaults: MODE_DEFAULTS[mode] || MODE_DEFAULTS.vnc,
  };
}
