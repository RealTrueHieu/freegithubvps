/**
 * Main Application Entry Point
 * Free VPS Dashboard - Supabase Style
 */

import { appState, actions, initState } from './state.js';
import { api } from './api.js';
import { Toast } from './components/Toast.js';
import { Modal } from './components/Modal.js';

// ---- Global State ----
let scanInterval = null;
let deployTimeout = null;
let machineTimers = new Map();

// ---- Utility Functions ----
function formatTime(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function copyToClipboard(text, successMsg = 'Copied!') {
  navigator.clipboard.writeText(text).then(() => {
    Toast.success(successMsg);
  }).catch(() => {
    Toast.error('Failed to copy');
  });
}

function getInitials(email) {
  return email.split('@')[0].slice(0, 2).toUpperCase();
}

function showScreen(screenId) {
  // Hide all screens
  document.querySelectorAll('[data-screen]').forEach(el => {
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  });
  
  // Show target screen
  const screen = document.getElementById(screenId);
  if (screen) {
    screen.classList.remove('hidden');
    screen.removeAttribute('aria-hidden');
  }
}

function setActiveTab(tabId) {
  document.querySelectorAll('[data-tab]').forEach(el => {
    el.classList.remove('tab--active', 'sidebar__item--active');
    el.setAttribute('aria-selected', 'false');
  });
  
  const activeTab = document.querySelector(`[data-tab="${tabId}"]`);
  if (activeTab) {
    activeTab.classList.add('tab--active', 'sidebar__item--active');
    activeTab.setAttribute('aria-selected', 'true');
  }
}

// ---- Auth Functions ----
async function handleLogin(event) {
  event.preventDefault();
  const form = event.target;
  const email = form.querySelector('#loginEmail').value.trim();
  const password = form.querySelector('#loginPassword').value;
  const btn = form.querySelector('#loginBtn');
  
  if (!email || !password) return Toast.error('Please fill in all fields');
  
  btn.classList.add('btn--loading');
  btn.querySelector('.btn-text').hidden = true;
  btn.querySelector('.btn-loading').hidden = false;
  btn.disabled = true;
  
  try {
    const data = await api.login(email, password);
    actions.setAuth(data);
    localStorage.setItem('sessionToken', data.sessionToken);
    Toast.success('Welcome back!');
    updateUIForAuth();
  } catch (error) {
    Toast.error(error.message);
  } finally {
    btn.classList.remove('btn--loading');
    btn.querySelector('.btn-text').hidden = false;
    btn.querySelector('.btn-loading').hidden = true;
    btn.disabled = false;
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const form = event.target;
  const email = form.querySelector('#regEmail').value.trim();
  const password = form.querySelector('#regPassword').value;
  const confirm = form.querySelector('#regConfirmPassword').value;
  const btn = form.querySelector('#registerBtn');
  
  if (!email || !password) return Toast.error('Please fill in all fields');
  if (password !== confirm) return Toast.error('Passwords do not match');
  if (password.length < 6) return Toast.error('Password must be at least 6 characters');
  
  btn.classList.add('btn--loading');
  btn.querySelector('.btn-text').hidden = true;
  btn.querySelector('.btn-loading').hidden = false;
  btn.disabled = true;
  
  try {
    const data = await api.register(email, password);
    actions.setAuth(data);
    localStorage.setItem('sessionToken', data.sessionToken);
    Toast.success('Account created!');
    updateUIForAuth();
  } catch (error) {
    Toast.error(error.message);
  } finally {
    btn.classList.remove('btn--loading');
    btn.querySelector('.btn-text').hidden = false;
    btn.querySelector('.btn-loading').hidden = true;
    btn.disabled = false;
  }
}

async function restoreSession() {
  const sessionToken = appState.raw.sessionToken.value;
  if (!sessionToken) return;
  
  try {
    const data = await api.restoreSession(sessionToken);
    actions.setAuth(data);
    updateUIForAuth();
    Toast.success('Session restored');
  } catch (error) {
    localStorage.removeItem('sessionToken');
    appState.set('sessionToken', '');
  }
}

function logout() {
  localStorage.removeItem('sessionToken');
  actions.logout();
  updateUIForAuth();
  Toast.success('Signed out');
}

function updateUIForAuth() {
  const isAuth = appState.raw.isAuthenticated.value;
  
  // Toggle sections
  document.getElementById('authSection')?.classList.toggle('hidden', isAuth);
  document.getElementById('authSuccessSection')?.classList.toggle('hidden', !isAuth);
  document.getElementById('tokenSection')?.classList.toggle('hidden', !isAuth || !!appState.raw.githubToken.value);
  document.getElementById('deploySection')?.classList.toggle('hidden', !isAuth || !appState.raw.githubToken.value);
  document.getElementById('machinesSection')?.classList.toggle('hidden', !isAuth);
  document.getElementById('shopSection')?.classList.toggle('hidden', !isAuth);
  
  if (isAuth) {
    document.getElementById('connectionSection')?.classList.toggle('hidden', !appState.raw.githubToken.value);
  } else {
    document.getElementById('connectionSection')?.classList.add('hidden');
  }
  
  // Update user info
  const email = appState.raw.email.value;
  const name = getInitials(email);
  
  document.getElementById('authUserName')?.textContent = email;
  document.getElementById('authUserEmail')?.textContent = email;
  document.getElementById('authAvatar')?.textContent = name;
  document.getElementById('sidebarUserName')?.textContent = email || 'Guest';
  document.getElementById('sidebarUserRole')?.textContent = isAuth ? appState.raw.role.value : 'Sign in to continue';
  document.getElementById('sidebarUserAvatar')?.textContent = name;
  document.getElementById('ddUserName')?.textContent = email || 'User';
  document.getElementById('ddUserEmail')?.textContent = email || 'user@example.com';
  document.getElementById('userName')?.textContent = email || 'Sign In';
  document.getElementById('userEmail')?.textContent = email || 'Welcome to TrueTeam';
  document.getElementById('userAvatar')?.textContent = name;
  
  // Update credits
  document.getElementById('creditsDisplay')?.textContent = appState.raw.credits.value;
  
  // Update machine count
  updateMachineCount();
  
  // Start machine timers
  startMachineTimers();
  
  // Load shop data
  loadShopData();
}

// ---- Token Functions ----
async function handleSaveToken(event) {
  event.preventDefault();
  const form = event.target;
  const token = form.querySelector('#tokenInput').value.trim();
  const btn = form.querySelector('#saveTokenBtn');
  
  if (!token) return Toast.error('Please enter your GitHub token');
  if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
    return Toast.error('Invalid token format. Should start with ghp_ or github_pat_');
  }
  
  btn.classList.add('btn--loading');
  btn.querySelector('.btn-text').hidden = true;
  btn.querySelector('.btn-loading').hidden = false;
  btn.disabled = true;
  
  try {
    await api.saveGithubToken(appState.raw.sessionToken.value, token);
    appState.set('githubToken', token);
    document.getElementById('tokenSection')?.classList.add('hidden');
    document.getElementById('deploySection')?.classList.remove('hidden');
    document.getElementById('connectionSection')?.classList.remove('hidden');
    Toast.success('Token saved!');
  } catch (error) {
    Toast.error(error.message);
  } finally {
    btn.classList.remove('btn--loading');
    btn.querySelector('.btn-text').hidden = false;
    btn.querySelector('.btn-loading').hidden = true;
    btn.disabled = false;
  }
}

function togglePasswordVisibility(inputId, buttonId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(buttonId);
  const icon = btn.querySelector('svg');
  
  if (input.type === 'password') {
    input.type = 'text';
    icon.innerHTML = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`;
  } else {
    input.type = 'password';
    icon.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
  }
}

// ---- Deploy Functions ----
function selectMode(mode) {
  actions.setDeployMode(mode);
  
  // Update UI
  document.querySelectorAll('.mode-card').forEach(card => {
    const isActive = card.dataset.mode === mode;
    card.classList.toggle('mode-card--active', isActive);
    card.setAttribute('aria-checked', isActive);
    card.querySelector('input').checked = isActive;
  });
  
  // Show/hide ngrok token input
  const ngrokGroup = document.getElementById('ngrokTokenGroup');
  if (ngrokGroup) {
    ngrokGroup.hidden = mode !== 'ngrok';
    ngrokGroup.setAttribute('aria-hidden', mode !== 'ngrok');
  }
  
  // Update deploy button state
  updateDeployButton();
}

function updateDeployButton() {
  const btn = document.getElementById('deployBtn');
  if (!btn) return;
  
  const hasToken = appState.raw.githubToken.value.length > 10;
  btn.disabled = !hasToken;
  
  if (!hasToken) {
    btn.querySelector('.btn-text').innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 18 22 12 16 6"></polyline>
        <polyline points="8 6 2 12 8 18"></polyline>
      </svg>
      Save GitHub Token First
    `;
  } else {
    btn.querySelector('.btn-text').innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 18 22 12 16 6"></polyline>
        <polyline points="8 6 2 12 8 18"></polyline>
      </svg>
      Start Deployment
    `;
  }
}

async function startDeployment() {
  const mode = appState.raw.deployMode.value;
  const token = appState.raw.githubToken.value;
  const sessionToken = appState.raw.sessionToken.value;
  
  if (!token || token.length < 10) {
    return Toast.error('Please save your GitHub token first');
  }
  
  // For ngrok mode, check if token is saved
  if (mode === 'ngrok' && !appState.raw.ngrokTokenSaved.value) {
    const ngrokToken = document.getElementById('ngrokTokenInput')?.value?.trim();
    if (!ngrokToken) {
      return Toast.error('Please enter your ngrok auth token');
    }
    try {
      await api.saveNgrokToken(sessionToken, ngrokToken);
      appState.set('ngrokTokenSaved', true);
      appState.set('ngrokToken', ngrokToken);
      document.getElementById('ngrokTokenSaved')?.classList.remove('hidden');
      Toast.success('Ngrok token saved!');
    } catch (error) {
      return Toast.error(error.message);
    }
  }
  
  // Reset deploy state
  actions.resetDeploy();
  actions.setDeployStatus('forking', 0, 1);
  showDeployProgress(true);
  
  const btn = document.getElementById('deployBtn');
  btn.disabled = true;
  btn.classList.add('btn--loading');
  btn.querySelector('.btn-text').hidden = true;
  btn.querySelector('.btn-loading').hidden = false;
  
  try {
    // Step 1: Fork Repository
    updateProgress(25, 1, 'Forking repository...');
    const forkResult = await api.forkRepo(token, sessionToken, mode);
    appState.set('owner', forkResult.owner);
    
    // Step 2: Configure & Run Workflow
    updateProgress(50, 2, 'Configuring secrets & starting workflow...');
    await api.runWorkflow(token, forkResult.owner, forkResult.name, sessionToken, mode);
    
    // Step 3: Wait for workflow, then fetch connection
    updateProgress(75, 3, 'Workflow running. Waiting for connection info...');
    actions.setDeployStatus('fetching');
    
    // Start polling for connection info
    startConnectionPolling();
    
  } catch (error) {
    actions.setDeployStatus('error', 0, 0, error.message);
    updateProgress(0, 0, `Error: ${error.message}`);
    Toast.error(error.message);
    setTimeout(() => showDeployProgress(false), 5000);
  } finally {
    btn.disabled = false;
    btn.classList.remove('btn--loading');
    btn.querySelector('.btn-text').hidden = false;
    btn.querySelector('.btn-loading').hidden = true;
  }
}

function showDeployProgress(show) {
  const progress = document.getElementById('deployProgress');
  const btn = document.getElementById('deployBtn');
  
  if (show) {
    progress.classList.remove('hidden');
    btn?.classList.add('hidden');
  } else {
    progress.classList.add('hidden');
    btn?.classList.remove('hidden');
  }
}

function updateProgress(percent, step, message) {
  actions.setDeployProgress(percent);
  actions.setDeployStep(step);
  
  document.getElementById('progressBar').style.width = `${percent}%`;
  document.getElementById('progressStatus').textContent = message;
  
  // Update step indicators
  document.querySelectorAll('.progress-step').forEach((el, i) => {
    const stepNum = i + 1;
    el.classList.toggle('progress-step--active', stepNum === step);
    el.classList.toggle('progress-step--complete', stepNum < step);
    el.classList.toggle('progress-step--error', stepNum === step && actions.raw.deployStatus.value === 'error');
  });
}

function startConnectionPolling() {
  let retries = 0;
  const maxRetries = 90; // 15 minutes at 10s intervals
  
  const poll = async () => {
    if (retries >= maxRetries) {
      actions.setDeployStatus('error', 0, 0, 'Timeout: Connection info not found after 15 minutes');
      Toast.error('Deployment timeout. Check GitHub Actions tab.');
      showDeployProgress(false);
      showConnectionError('Timeout: Workflow did not produce connection info in time. Check GitHub Actions for errors.');
      return;
    }
    
    retries++;
    actions.setScanRetries(retries);
    
    try {
      const mode = appState.raw.deployMode.value;
      const token = appState.raw.githubToken.value;
      const owner = appState.raw.owner.value;
      const sessionToken = appState.raw.sessionToken.value;
      const repo = mode === 'bore' ? 'vps-bore' : mode.startsWith('ngrok') ? 'vps-ngrok' : 'vps-novnc';
      
      const result = await api.getRdpInfo(token, owner, repo, sessionToken, mode);
      
      if (result.found && result.info.ngrok_url) {
        // Success!
        actions.setConnectionInfo(result.info);
        actions.setDeployStatus('complete', 100, 4);
        updateProgress(100, 4, 'Connection info retrieved!');
        showDeployProgress(false);
        showConnectionSuccess(result.info);
        
        // Refresh machines list
        const machines = await api.getMachines(sessionToken);
        actions.setMachines(machines);
        renderMachines();
        updateMachineCount();
        startMachineTimers();
        
        Toast.success('VPS is ready!');
        return;
      }
      
      // Not ready yet, continue polling
      const elapsed = retries * 10;
      const modeNames = { vnc: 'noVNC', bore: 'Bore RDP', ngrok: 'Ngrok', ngrok_fast: 'Ngrok Fast' };
      updateProgress(75, 3, `Waiting for ${modeNames[mode]}... (${elapsed}s elapsed)`);
      
      setTimeout(poll, 10000);
    } catch (error) {
      if (error.message.includes('not found') || error.message.includes('404')) {
        // Expected during polling
        setTimeout(poll, 10000);
      } else {
        Toast.error(error.message);
        setTimeout(poll, 10000);
      }
    }
  };
  
  // Initial delay before first poll
  setTimeout(poll, 30000);
}

// ---- Connection Display ----
function showConnectionSuccess(info) {
  document.getElementById('scanningState')?.classList.add('hidden');
  document.getElementById('connectionError')?.classList.add('hidden');
  document.getElementById('connectionSuccess')?.classList.remove('hidden');
  
  const mode = appState.raw.deployMode.value;
  const isRdp = mode === 'bore' || mode.startsWith('ngrok');
  
  document.getElementById('connectionTitleText')?.textContent = isRdp ? 'RDP Connection Ready!' : 'noVNC Connection Ready!';
  document.getElementById('connectionDetailText')?.textContent = isRdp 
    ? 'Use the credentials below to connect via Remote Desktop (mstsc)'
    : 'Click the link below to open noVNC in your browser';
  
  document.getElementById('connectionUrl')?.textContent = info.ngrok_url || '';
  document.getElementById('connUsername')?.textContent = info.username || (isRdp ? 'admin' : 'noVNC');
  document.getElementById('connPassword')?.textContent = info.password || (mode === 'vnc' ? 'hieudz' : 'WindowsRDP2026@');
  
  // Quick connect for RDP
  const quickConnectCard = document.getElementById('quickConnectCard');
  const rdpCommand = document.getElementById('rdpCommand');
  if (isRdp && info.ngrok_url) {
    quickConnectCard?.classList.remove('hidden');
    rdpCommand.value = `mstsc /v:${info.ngrok_url}`;
  } else {
    quickConnectCard?.classList.add('hidden');
  }
  
  // Update hint
  const urlHint = document.getElementById('urlHint');
  if (urlHint) {
    urlHint.textContent = isRdp ? 'Use with Remote Desktop (mstsc)' : 'Open in browser for noVNC';
  }
}

function showConnectionError(message) {
  document.getElementById('scanningState')?.classList.add('hidden');
  document.getElementById('connectionSuccess')?.classList.add('hidden');
  const errorEl = document.getElementById('connectionError');
  errorEl?.classList.remove('hidden');
  document.getElementById('connectionErrorMsg')?.textContent = message;
}

async function fetchConnectionNow() {
  const btn = document.getElementById('fetchConnectionBtn');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  
  try {
    const mode = appState.raw.deployMode.value;
    const token = appState.raw.githubToken.value;
    const owner = appState.raw.owner.value;
    const sessionToken = appState.raw.sessionToken.value;
    const repo = mode === 'bore' ? 'vps-bore' : mode.startsWith('ngrok') ? 'vps-ngrok' : 'vps-novnc';
    
    const result = await api.getRdpInfo(token, owner, repo, sessionToken, mode);
    
    if (result.found && result.info.ngrok_url) {
      actions.setConnectionInfo(result.info);
      showConnectionSuccess(result.info);
      Toast.success('Connection info found!');
    } else {
      showConnectionError('Workflow still running. Please wait a bit longer.');
    }
  } catch (error) {
    showConnectionError(error.message);
    Toast.error(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check Now';
  }
}

async function refreshConnection() {
  const btn = document.getElementById('refreshConnectionBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner spinner--sm"></span> Refreshing...';
  
  try {
    const mode = appState.raw.deployMode.value;
    const token = appState.raw.githubToken.value;
    const owner = appState.raw.owner.value;
    const sessionToken = appState.raw.sessionToken.value;
    const repo = mode === 'bore' ? 'vps-bore' : mode.startsWith('ngrok') ? 'vps-ngrok' : 'vps-novnc';
    
    const result = await api.refreshMachine(token, sessionToken, appState.raw.selectedMachineId.value);
    
    if (result.found && result.info.ngrok_url) {
      actions.setConnectionInfo(result.info);
      showConnectionSuccess(result.info);
      Toast.success('Connection refreshed!');
      
      // Update machines list
      if (result.machines) {
        actions.setMachines(result.machines);
        renderMachines();
      }
    } else {
      Toast.error('No new connection info available yet');
    }
  } catch (error) {
    Toast.error(error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 4v6h-6"></path>
        <path d="M1 20v-6h6"></path>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
      Refresh
    `;
  }
}

async function deleteMachine() {
  const machine = appState.raw.machineToDelete.value;
  if (!machine) return;
  
  const btn = document.getElementById('deleteModalConfirm');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner spinner--sm"></span> Deleting...';
  
  try {
    const result = await api.deleteMachine(
      appState.raw.sessionToken.value,
      machine.id,
      appState.raw.githubToken.value
    );
    
    if (result.machines) {
      actions.setMachines(result.machines);
      renderMachines();
      updateMachineCount();
    }
    
    actions.closeDeleteModal();
    Toast.success('Machine deleted');
  } catch (error) {
    Toast.error(error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Delete Machine
    `;
  }
}

// ---- Machine Functions ----
function renderMachines() {
  const grid = document.getElementById('machinesGrid');
  const empty = document.getElementById('machinesEmpty');
  const machines = appState.raw.machines.value;
  
  if (!machines || machines.length === 0) {
    grid?.classList.add('hidden');
    empty?.classList.remove('hidden');
    return;
  }
  
  grid?.classList.remove('hidden');
  empty?.classList.add('hidden');
  
  grid.innerHTML = machines.map(machine => createMachineCard(machine)).join('');
  
  // Add click handlers for copy buttons
  grid.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = btn.dataset.target;
      const target = document.getElementById(targetId);
      if (target) copyToClipboard(target.textContent, `${targetId.replace('conn', '').replace('Url', ' URL')} copied!`);
    });
  });
}

function classifyMachineClient(machine = {}) {
  const repoLow = String(machine.repo || '').toLowerCase();
  const display = String(machine.ngrok_url || machine.url || '').trim();
  let modeKey = null;
  if (repoLow.includes('ngrok')) modeKey = 'ngrok';
  else if (repoLow.includes('bore')) modeKey = 'bore';
  else if (repoLow.includes('novnc') || repoLow.includes('vnc')) modeKey = 'vnc';
  if (!modeKey) {
    if (/^https?:\/\//i.test(display)) modeKey = 'vnc';
    else if (/ngrok\.io/i.test(display) || /\.tcp\./i.test(display)) modeKey = 'ngrok';
    else if (/bore\.pub/i.test(display) || /^[^\s/]+:\d+$/.test(display)) modeKey = 'bore';
    else modeKey = 'vnc';
  }
  const labels = { vnc: 'noVNC', bore: 'Bore RDP', ngrok: 'Ngrok RDP', ngrok_fast: 'Ngrok Fast' };
  return {
    mode: modeKey,
    label: labels[modeKey] || modeKey,
    isVnc: modeKey === 'vnc',
    isBore: modeKey === 'bore',
    isNgrok: modeKey === 'ngrok' || modeKey === 'ngrok_fast',
    isRdp: modeKey === 'bore' || modeKey === 'ngrok' || modeKey === 'ngrok_fast',
  };
}

function createMachineCard(machine) {
  const createdAt = machine.createdAt || machine.created_at || 0;
  const elapsed = Date.now() - createdAt;
  const remaining = 5 * 60 * 60 * 1000 - elapsed;
  const isExpired = remaining <= 0;
  const classified = classifyMachineClient(machine);
  const isRdp = classified.isRdp;
  const mode = classified.label || machine.repo;

  const statusColor = machine.status === 'active' ? 'success' : machine.status === 'dead' ? 'error' : 'warning';
  const statusText = machine.status === 'active' ? 'Online' : machine.status === 'dead' ? 'Offline' : 'Unknown';
  
  return `
    <article class="card machine-card ${isExpired ? 'machine-card--expired' : ''}" data-machine-id="${machine.id}">
      <div class="card__header" style="padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--color-border-primary);">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <div class="avatar avatar--sm" style="background: linear-gradient(135deg, var(--color-brand-500), var(--color-brand-700));">
              ${isRdp ? '🖥️' : '🌐'}
            </div>
            <div>
              <h3 style="font-size: var(--text-base); font-weight: var(--font-semibold); color: var(--color-text-primary);">${mode}</h3>
              <p style="font-size: var(--text-xs); color: var(--color-text-tertiary); font-family: var(--font-mono);">#${machine.id}</p>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: var(--space-2);">
            <span class="badge badge--${statusColor} badge--dot">${statusText}</span>
            <span class="badge badge--default" id="timer-${machine.id}">${formatTime(Math.max(0, remaining))}</span>
          </div>
        </div>
      </div>
      <div class="card__content" style="padding: var(--space-4) var(--space-5);">
        <div style="display: grid; gap: var(--space-3);">
          ${isRdp ? `
            <div class="connection-field">
              <label style="font-size: var(--text-xs); color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Address</label>
              <div style="display: flex; gap: var(--space-2);">
                <code class="input" id="addr-${machine.id}" style="flex: 1; font-family: var(--font-mono); font-size: var(--text-sm); background: var(--color-bg-tertiary); border-color: var(--color-border-primary); padding: var(--space-2) var(--space-3);" readonly>${machine.ngrok_url || 'Pending...'}</code>
                <button class="btn btn--ghost btn--sm copy-btn" data-target="addr-${machine.id}" aria-label="Copy address">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
              </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
              <div class="connection-field">
                <label style="font-size: var(--text-xs); color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Username</label>
                <div style="display: flex; gap: var(--space-2);">
                  <code class="input" id="user-${machine.id}" style="flex: 1; font-family: var(--font-mono); font-size: var(--text-sm); background: var(--color-bg-tertiary); border-color: var(--color-border-primary); padding: var(--space-2) var(--space-3);" readonly>${machine.username || 'admin'}</code>
                  <button class="btn btn--ghost btn--sm copy-btn" data-target="user-${machine.id}" aria-label="Copy username">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
              </div>
              <div class="connection-field">
                <label style="font-size: var(--text-xs); color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Password</label>
                <div style="display: flex; gap: var(--space-2);">
                  <code class="input" id="pass-${machine.id}" style="flex: 1; font-family: var(--font-mono); font-size: var(--text-sm); background: var(--color-bg-tertiary); border-color: var(--color-border-primary); padding: var(--space-2) var(--space-3);" readonly>${machine.password || 'WindowsRDP2026@'}</code>
                  <button class="btn btn--ghost btn--sm copy-btn" data-target="pass-${machine.id}" aria-label="Copy password">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
              </div>
            </div>
            <div class="connection-field">
              <label style="font-size: var(--text-xs); color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Quick Connect (mstsc)</label>
              <div style="display: flex; gap: var(--space-2);">
                <code class="input" id="rdp-${machine.id}" style="flex: 1; font-family: var(--font-mono); font-size: var(--text-sm); background: var(--color-bg-tertiary); border-color: var(--color-border-primary); padding: var(--space-2) var(--space-3);" readonly>${machine.ngrok_url ? `mstsc /v:${machine.ngrok_url}` : 'Pending...'}</code>
                <button class="btn btn--secondary btn--sm copy-btn" data-target="rdp-${machine.id}" aria-label="Copy RDP command">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
              </div>
            </div>
          ` : `
            <div class="connection-field">
              <label style="font-size: var(--text-xs); color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">noVNC URL</label>
              <div style="display: flex; gap: var(--space-2);">
                <code class="input" id="url-${machine.id}" style="flex: 1; font-family: var(--font-mono); font-size: var(--text-sm); background: var(--color-bg-tertiary); border-color: var(--color-border-primary); padding: var(--space-2) var(--space-3);" readonly>${machine.ngrok_url || 'Pending...'}</code>
                <button class="btn btn--ghost btn--sm copy-btn" data-target="url-${machine.id}" aria-label="Copy URL">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
              </div>
            </div>
            <div class="connection-field">
              <label style="font-size: var(--text-xs); color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em;">Password</label>
              <div style="display: flex; gap: var(--space-2);">
                <code class="input" id="vnc-pass-${machine.id}" style="flex: 1; font-family: var(--font-mono); font-size: var(--text-sm); background: var(--color-bg-tertiary); border-color: var(--color-border-primary); padding: var(--space-2) var(--space-3);" readonly>${machine.password || 'hieudz'}</code>
                <button class="btn btn--ghost btn--sm copy-btn" data-target="vnc-pass-${machine.id}" aria-label="Copy password">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </button>
              </div>
            </div>
          `}
        </div>
      </div>
      <div class="card__footer">
        <button class="btn btn--secondary btn--sm" onclick="pingMachine('${machine.id}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          Ping
        </button>
        <button class="btn btn--secondary btn--sm" onclick="refreshMachine('${machine.id}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
          Refresh
        </button>
        <button class="btn btn--danger btn--sm" onclick="openDeleteModal('${machine.id}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          Delete
        </button>
      </div>
    </article>
  `;
}

function updateMachineCount() {
  const count = appState.raw.machines.value.length;
  document.getElementById('machineCount')?.textContent = count;
  document.getElementById('machineCount')?.style.display = count > 0 ? 'inline-flex' : 'none';
}

function startMachineTimers() {
  // Clear existing timers
  machineTimers.forEach(timer => clearInterval(timer));
  machineTimers.clear();
  
  const machines = appState.raw.machines.value;
  machines.forEach(machine => {
    const timer = setInterval(() => {
      const createdAt = machine.createdAt || machine.created_at || 0;
      const remaining = 5 * 60 * 60 * 1000 - (Date.now() - createdAt);
      const timerEl = document.getElementById(`timer-${machine.id}`);
      if (timerEl) {
        timerEl.textContent = formatTime(Math.max(0, remaining));
        if (remaining <= 0) {
          timerEl.parentElement.querySelector('.badge--dot')?.classList.replace('badge--success', 'badge--error');
          timerEl.parentElement.querySelector('.badge--dot')?.textContent = 'Expired';
          clearInterval(timer);
          machineTimers.delete(machine.id);
        }
      } else {
        clearInterval(timer);
        machineTimers.delete(machine.id);
      }
    }, 1000);
    machineTimers.set(machine.id, timer);
  });
}

async function pingMachine(machineId) {
  const btn = event?.target?.closest('button');
  const originalText = btn?.innerHTML;
  
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner--sm"></span>';
  }
  
  try {
    await api.pingMachine(appState.raw.githubToken.value, appState.raw.sessionToken.value, machineId);
    Toast.success('Machine is online!');
    // Update status badge
    const badge = document.querySelector(`[data-machine-id="${machineId}"] .badge--dot`);
    if (badge) {
      badge.classList.remove('badge--warning', 'badge--error');
      badge.classList.add('badge--success');
      badge.textContent = 'Online';
    }
  } catch (error) {
    Toast.error(error.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }
}

async function refreshMachine(machineId) {
  const btn = event?.target?.closest('button');
  const originalText = btn?.innerHTML;
  
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner--sm"></span>';
  }
  
  try {
    const result = await api.refreshMachine(appState.raw.githubToken.value, appState.raw.sessionToken.value, machineId);
    
    if (result.machines) {
      actions.setMachines(result.machines);
      renderMachines();
      startMachineTimers();
    }
    
    if (result.found && result.info.ngrok_url) {
      Toast.success('Connection info updated!');
    } else {
      Toast.error('Workflow has not produced new connection info yet');
    }
  } catch (error) {
    Toast.error(error.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }
}

function openDeleteModal(machineId) {
  const machine = appState.raw.machines.value.find(m => m.id === machineId);
  if (!machine) return;
  
  actions.openDeleteModal(machine);
  document.getElementById('deleteMachineName').textContent = `${machine.repo} (${machine.id})`;
  Modal.open('deleteModal');
}

// ---- Shop Functions ----
async function loadShopData() {
  try {
    const [config, products] = await Promise.all([
      api.getShopConfig(),
      api.getProducts(),
    ]);
    
    actions.setShopConfig(config);
    actions.setShopProducts(products);
    renderShop(config, products);
  } catch (error) {
    console.error('Failed to load shop:', error);
  }
}

function renderShop(config, products) {
  // Banner
  if (config.bannerText) {
    document.getElementById('shopBannerText').textContent = config.bannerText;
  }
  
  if (config.logoUrl) {
    document.getElementById('shopLogoImg').src = config.logoUrl;
    document.getElementById('shopLogoContainer').classList.remove('hidden');
  }
  
  // Bank info
  if (config.bankName && config.bankAccount && config.bankHolder) {
    document.getElementById('bankNameDisplay').textContent = config.bankName;
    document.getElementById('bankAccountDisplay').textContent = config.bankAccount;
    document.getElementById('bankHolderDisplay').textContent = config.bankHolder;
    document.getElementById('bankInfoCard').classList.remove('hidden');
  }
  
  if (config.qrUrl) {
    document.getElementById('qrCodeImg').src = config.qrUrl;
    document.getElementById('qrCodeContainer').classList.remove('hidden');
  }
  
  // Products
  const grid = document.getElementById('productsGrid');
  if (products.length === 0) {
    grid.innerHTML = `
      <div class="card empty-state" style="grid-column: 1 / -1; text-align: center; padding: var(--space-10);">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--color-text-tertiary); margin-bottom: var(--space-3);">
          <circle cx="9" cy="21" r="1"></circle>
          <circle cx="20" cy="21" r="1"></circle>
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
        </svg>
        <p style="color: var(--color-text-secondary);">No products available</p>
      </div>
    `;
    return;
  }
  
  grid.innerHTML = products.map(product => `
    <article class="card product-card" style="display: flex; flex-direction: column; transition: border-color var(--transition-fast), transform var(--transition-fast);" tabindex="0">
      ${product.image_url ? `
        <div style="aspect-ratio: 16/10; border-radius: var(--radius-md) var(--radius-md) 0 0; overflow: hidden; margin: calc(-1 * var(--space-5)) calc(-1 * var(--space-5)) 0; background: var(--color-bg-tertiary);">
          <img src="${product.image_url}" alt="${product.name}" style="width: 100%; height: 100%; object-fit: cover; transition: transform var(--transition-normal);">
        </div>
      ` : ''}
      <div class="card__content" style="padding: var(--space-4); display: flex; flex-direction: column; flex: 1;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2);">
          <h3 style="font-size: var(--text-base); font-weight: var(--font-semibold); color: var(--color-text-primary); flex: 1;">${product.name}</h3>
          <span class="badge badge--brand" style="font-size: var(--text-xs);">${product.price} credits</span>
        </div>
        ${product.description ? `
          <p style="font-size: var(--text-sm); color: var(--color-text-secondary); line-height: var(--leading-relaxed); margin-bottom: var(--space-3); flex: 1;">${product.description}</p>
        ` : ''}
        <div style="display: flex; gap: var(--space-2); margin-top: auto;">
          <button class="btn btn--primary btn--block btn--sm" onclick="buyProduct('${product.id}')">
            Buy for ${product.price} Credits
          </button>
        </div>
      </div>
    </article>
  `).join('');
}

async function buyProduct(productId) {
  const product = appState.raw.shopProducts.value.find(p => p.id === productId);
  if (!product) return;
  
  if (appState.raw.credits.value < product.price) {
    return Toast.error(`Not enough credits! You have ${appState.raw.credits.value}, need ${product.price}`);
  }
  
  // This would need a backend endpoint - for now just show toast
  Toast.info('Purchase functionality requires backend endpoint');
}

// ---- Notification Functions ----
function renderNotifications() {
  const list = document.getElementById('notifList');
  const notifications = appState.raw.notifications.value;
  
  if (notifications.length === 0) {
    list.innerHTML = `
      <div class="empty-state" style="padding: var(--space-8); text-align: center;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--color-text-tertiary); margin-bottom: var(--space-2);">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <p style="color: var(--color-text-secondary); font-size: var(--text-sm);">No notifications</p>
      </div>
    `;
    return;
  }
  
  list.innerHTML = notifications.map((notif, index) => `
    <button class="dropdown__item ${!notif.read ? 'dropdown__item--unread' : ''}" style="text-align: left; padding: var(--space-3); border-radius: var(--radius-sm);" onclick="markNotificationRead(${index})">
      <div style="display: flex; gap: var(--space-3);">
        <span style="font-size: var(--text-lg); flex-shrink: 0;">${getNotificationIcon(notif.type)}</span>
        <div style="flex: 1; min-width: 0;">
          <p style="font-size: var(--text-sm); color: var(--color-text-primary); font-weight: ${!notif.read ? 'var(--font-semibold)' : 'var(--font-normal)'};">${notif.message}</p>
          <p style="font-size: var(--text-xs); color: var(--color-text-tertiary); margin-top: 2px;">${formatDate(notif.time)}</p>
        </div>
      </div>
    </button>
  `).join('');
}

function getNotificationIcon(type) {
  switch (type) {
    case 'success': return '✅';
    case 'error': return '❌';
    case 'warning': return '⚠️';
    case 'info':
    default: return 'ℹ️';
  }
}

function markNotificationRead(index) {
  actions.markNotificationRead(index);
  renderNotifications();
}

function clearAllNotifications() {
  actions.clearNotifications();
  renderNotifications();
  Modal.close('notifDropdown');
}

// ---- UI Event Handlers ----
function setupEventListeners() {
  // Auth tabs
  document.querySelectorAll('#authTabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      actions.setAuthMode(tab.dataset.tab);
      updateAuthTabs();
    });
  });
  
  // Forms
  document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
  document.getElementById('registerForm')?.addEventListener('submit', handleRegister);
  document.getElementById('tokenForm')?.addEventListener('submit', handleSaveToken);
  
  // Password toggles
  document.getElementById('toggleLoginPassword')?.addEventListener('click', () => togglePasswordVisibility('loginPassword', 'toggleLoginPassword'));
  document.getElementById('toggleRegPassword')?.addEventListener('click', () => togglePasswordVisibility('regPassword', 'toggleRegPassword'));
  document.getElementById('toggleRegConfirmPassword')?.addEventListener('click', () => togglePasswordVisibility('regConfirmPassword', 'toggleRegConfirmPassword'));
  document.getElementById('toggleToken')?.addEventListener('click', () => togglePasswordVisibility('tokenInput', 'toggleToken'));
  document.getElementById('toggleNgrokToken')?.addEventListener('click', () => togglePasswordVisibility('ngrokTokenInput', 'toggleNgrokToken'));
  
  // Mode selector
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => selectMode(card.dataset.mode));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectMode(card.dataset.mode);
      }
    });
  });
  
  // Deploy button
  document.getElementById('deployBtn')?.addEventListener('click', startDeployment);
  
  // Connection actions
  document.getElementById('fetchConnectionBtn')?.addEventListener('click', fetchConnectionNow);
  document.getElementById('refreshConnectionBtn')?.addEventListener('click', refreshConnection);
  document.getElementById('deleteMachineBtn')?.addEventListener('click', () => openDeleteModal(appState.raw.selectedMachineId.value));
  document.getElementById('copyUrlBtn')?.addEventListener('click', () => copyToClipboard(document.getElementById('connectionUrl')?.textContent || '', 'URL copied!'));
  
  // Copy buttons for connection info
  document.querySelectorAll('.copy-btn[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) copyToClipboard(target.textContent, 'Copied!');
    });
  });
  
  // Logout
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
  document.getElementById('ddLogout')?.addEventListener('click', () => { logout(); Modal.close('userDropdown'); });
  
  // Tab navigation
  document.querySelectorAll('[data-tab]').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = tab.dataset.tab;
      actions.setTab(tabId);
      showScreen(`${tabId}Section`);
      setActiveTab(tabId);
      
      // Close mobile sidebar
      document.getElementById('sidebar')?.classList.remove('sidebar--open');
      document.getElementById('sidebarOverlay')?.classList.remove('hidden');
    });
  });
  
  // Sidebar toggle
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('sidebar--open');
    document.getElementById('sidebarOverlay')?.classList.toggle('hidden');
  });
  
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('sidebar--open');
    document.getElementById('sidebarOverlay')?.classList.add('hidden');
  });
  
  // User dropdown
  document.getElementById('userMenuTrigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    Modal.toggle('userDropdown');
  });
  
  // Notification dropdown
  document.getElementById('notifBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    renderNotifications();
    Modal.toggle('notifDropdown');
  });
  
  document.getElementById('clearNotifs')?.addEventListener('click', clearAllNotifications);
  
  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown') && !e.target.closest('[aria-haspopup="true"]')) {
      document.querySelectorAll('.dropdown').forEach(d => d.classList.add('hidden'));
    }
  });
  
  // Delete modal
  document.getElementById('deleteModalClose')?.addEventListener('click', () => { actions.closeDeleteModal(); Modal.close('deleteModal'); });
  document.getElementById('deleteModalCancel')?.addEventListener('click', () => { actions.closeDeleteModal(); Modal.close('deleteModal'); });
  document.getElementById('deleteModalConfirm')?.addEventListener('click', deleteMachine);
  
  // Go to deploy from empty machines
  document.getElementById('goToDeployBtn')?.addEventListener('click', () => {
    actions.setTab('deploy');
    showScreen('deploySection');
    setActiveTab('deploy');
  });
  
  // Keyboard navigation for modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => Modal.close(m.id));
      document.querySelectorAll('.dropdown:not(.hidden)').forEach(d => d.classList.add('hidden'));
    }
  });
}

function updateAuthTabs() {
  const mode = appState.raw.authMode.value;
  
  document.getElementById('loginTab')?.classList.toggle('tab--active', mode === 'login');
  document.getElementById('registerTab')?.classList.toggle('tab--active', mode === 'register');
  document.getElementById('loginTab')?.setAttribute('aria-selected', mode === 'login');
  document.getElementById('registerTab')?.setAttribute('aria-selected', mode === 'register');
  
  document.getElementById('loginPanel')?.hidden = mode !== 'login';
  document.getElementById('registerPanel')?.hidden = mode !== 'register';
  
  document.getElementById('loginPanel')?.setAttribute('aria-hidden', mode !== 'login');
  document.getElementById('registerPanel')?.setAttribute('aria-hidden', mode !== 'register');
}

// ---- Initialization ----
function init() {
  initState();
  setupEventListeners();
  updateAuthTabs();
  updateDeployButton();
  updateUIForAuth();
  
  // Check for saved session
  if (appState.raw.sessionToken.value) {
    restoreSession();
  }
  
  console.log('🚀 TrueTeam Cloud Dashboard initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose functions globally for inline onclick handlers
window.selectMode = selectMode;
window.togglePasswordVisibility = togglePasswordVisibility;
window.startDeployment = startDeployment;
window.fetchConnectionNow = fetchConnectionNow;
window.refreshConnection = refreshConnection;
window.openDeleteModal = openDeleteModal;
window.deleteMachine = deleteMachine;
window.pingMachine = pingMachine;
window.refreshMachine = refreshMachine;
window.copyToClipboard = copyToClipboard;
window.markNotificationRead = markNotificationRead;
window.buyProduct = buyProduct;

export { init };