/**
 * Reactive State Management - Signals-based Store
 * Lightweight, no dependencies, fine-grained reactivity
 */

// ---- Signal Implementation ----
function createSignal(initialValue) {
  let value = initialValue;
  const subscribers = new Set();
  
  const signal = {
    get value() {
      if (currentSubscriber) subscribers.add(currentSubscriber);
      return value;
    },
    set value(newValue) {
      if (newValue !== value) {
        value = newValue;
        subscribers.forEach(fn => fn());
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    peek() { return value; },
  };
  
  return signal;
}

let currentSubscriber = null;

function effect(fn) {
  const cleanup = () => {
    currentSubscriber = null;
  };
  
  const run = () => {
    currentSubscriber = run;
    try {
      fn();
    } finally {
      cleanup();
    }
  };
  
  run();
  return cleanup;
}

// ---- Computed Signal ----
function computed(fn) {
  const signal = createSignal(undefined);
  let stale = true;
  
  effect(() => {
    stale = true;
  });
  
  return {
    get value() {
      if (stale) {
        signal.value = fn();
        stale = false;
      }
      return signal.value;
    },
  };
}

// ---- Store ----
const state = {
  // Auth
  email: createSignal(''),
  password: createSignal(''),
  sessionToken: createSignal(localStorage.getItem('sessionToken') || ''),
  isAuthenticated: computed(() => !!state.sessionToken.value && state.sessionToken.value.length > 20),
  githubToken: createSignal(''),
  owner: createSignal(''),
  role: createSignal('user'),
  ngrokTokenSaved: createSignal(false),
  ngrokToken: createSignal(''),
  credits: createSignal(0),
  
  // Auth UI
  authMode: createSignal('login'), // 'login' | 'register'
  
  // Deploy
  deployMode: createSignal('vnc'), // 'vnc' | 'bore' | 'ngrok' | 'ngrok_fast'
  deployStatus: createSignal('idle'), // 'idle' | 'forking' | 'configuring' | 'running' | 'fetching' | 'complete' | 'error'
  deployProgress: createSignal(0),
  deployStep: createSignal(0),
  scanRetries: createSignal(0),
  connectionInfo: createSignal(null),
  selectedMachineId: createSignal(null),
  
  // Machines
  machines: createSignal([]),
  
  // Shop
  shopConfig: createSignal({
    bannerText: '🚀 TrueTeam Cloud — Free VPS for Everyone!',
    logoUrl: null,
    bankName: '',
    bankAccount: '',
    bankHolder: '',
    qrUrl: null,
  }),
  shopProducts: createSignal([]),
  
  // UI
  currentTab: createSignal('deploy'),
  notifications: createSignal([]),
  
  // Modals
  deleteModal: createSignal({ open: false, machine: null }),
};

function initState() {
  // Subscribe to sessionToken changes to persist
  state.sessionToken.subscribe((newToken) => {
    if (newToken) {
      localStorage.setItem('sessionToken', newToken);
    } else {
      localStorage.removeItem('sessionToken');
    }
  });
  
  // Load notifications from localStorage
  const savedNotifs = localStorage.getItem('notifs');
  if (savedNotifs) {
    try {
      state.notifications.value = JSON.parse(savedNotifs);
    } catch (e) {
      state.notifications.value = [];
    }
  }
  
  // Persist notifications
  state.notifications.subscribe((notifs) => {
    localStorage.setItem('notifs', JSON.stringify(notifs.slice(0, 50)));
  });
}

function addNotification(message, type = 'info') {
  const notifs = state.notifications.value;
  notifs.unshift({
    id: Date.now() + Math.random(),
    message,
    type,
    time: Date.now(),
    read: false,
  });
  state.notifications.value = notifs.slice(0, 50);
  
  // Update badge
  updateNotificationBadge();
}

function updateNotificationBadge() {
  const unread = state.notifications.value.filter(n => !n.read).length;
  const badge = document.getElementById('notifCount');
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.style.display = unread > 0 ? 'flex' : 'none';
  }
}

// ---- Actions ----
const actions = {
  // Auth
  setAuth(data) {
    state.email.value = data.email;
    state.sessionToken.value = data.sessionToken;
    state.githubToken.value = data.githubToken || '';
    state.owner.value = data.owner || '';
    state.machines.value = data.machines || [];
    state.credits.value = data.credits || 0;
    state.role.value = data.role || 'user';
    state.ngrokTokenSaved.value = data.ngrokTokenSaved || false;
  },
  
  setAuthMode(mode) {
    state.authMode.value = mode;
  },
  
  logout() {
    state.email.value = '';
    state.sessionToken.value = '';
    state.githubToken.value = '';
    state.owner.value = '';
    state.machines.value = [];
    state.credits.value = 0;
    state.role.value = 'user';
    state.ngrokTokenSaved.value = false;
    state.ngrokToken.value = '';
    state.deployMode.value = 'vnc';
    state.deployStatus.value = 'idle';
    state.connectionInfo.value = null;
    state.selectedMachineId.value = null;
  },
  
  // Deploy
  setDeployMode(mode) {
    state.deployMode.value = mode;
  },
  
  setDeployStatus(status, progress = 0, step = 0, error = null) {
    state.deployStatus.value = status;
    state.deployProgress.value = progress;
    state.deployStep.value = step;
    if (error) {
      addNotification(error, 'error');
    }
  },
  
  setDeployProgress(progress) {
    state.deployProgress.value = progress;
  },
  
  setDeployStep(step) {
    state.deployStep.value = step;
  },
  
  resetDeploy() {
    state.deployStatus.value = 'idle';
    state.deployProgress.value = 0;
    state.deployStep.value = 0;
    state.scanRetries.value = 0;
    state.connectionInfo.value = null;
  },
  
  setConnectionInfo(info) {
    state.connectionInfo.value = info;
  },
  
  // Machines
  setMachines(machines) {
    state.machines.value = machines || [];
  },
  
  updateMachine(machineId, updates) {
    const machines = state.machines.value.map(m => 
      m.id === machineId ? { ...m, ...updates } : m
    );
    state.machines.value = machines;
  },
  
  removeMachine(machineId) {
    state.machines.value = state.machines.value.filter(m => m.id !== machineId);
  },
  
  // Shop
  setShopConfig(config) {
    state.shopConfig.value = config;
  },
  
  setShopProducts(products) {
    state.shopProducts.value = products || [];
  },
  
  addCredits(amount) {
    state.credits.value += amount;
  },
  
  // UI
  setTab(tab) {
    state.currentTab.value = tab;
  },
  
  // Notifications
  addNotification(message, type = 'info') {
    addNotification(message, type);
  },
  
  markNotificationRead(index) {
    const notifs = [...state.notifications.value];
    if (notifs[index]) {
      notifs[index].read = true;
      state.notifications.value = notifs;
      updateNotificationBadge();
    }
  },
  
  clearNotifications() {
    state.notifications.value = [];
    updateNotificationBadge();
  },
  
  // Modals
  openDeleteModal(machine) {
    state.deleteModal.value = { open: true, machine };
  },
  
  closeDeleteModal() {
    state.deleteModal.value = { open: false, machine: null };
  },
  
  setSelectedMachineId(id) {
    state.selectedMachineId.value = id;
  },
};

// Export reactive state for direct access
const raw = {
  email: state.email,
  password: state.password,
  sessionToken: state.sessionToken,
  isAuthenticated: state.isAuthenticated,
  githubToken: state.githubToken,
  owner: state.owner,
  role: state.role,
  ngrokTokenSaved: state.ngrokTokenSaved,
  ngrokToken: state.ngrokToken,
  credits: state.credits,
  authMode: state.authMode,
  deployMode: state.deployMode,
  deployStatus: state.deployStatus,
  deployProgress: state.deployProgress,
  deployStep: state.deployStep,
  scanRetries: state.scanRetries,
  connectionInfo: state.connectionInfo,
  machines: state.machines,
  shopConfig: state.shopConfig,
  shopProducts: state.shopProducts,
  currentTab: state.currentTab,
  notifications: state.notifications,
  deleteModal: state.deleteModal,
  selectedMachineId: state.selectedMachineId,
};

export { state as appState, raw, actions, initState, effect, computed, createSignal };