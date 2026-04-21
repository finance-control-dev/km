'use strict';

import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, writeBatch, deleteDoc } from "firebase/firestore";

/* ==========================================
   FIREBASE CONFIGURATION
   ========================================== */

const firebaseConfig = {
  apiKey: "AIzaSyAXp_ZBYUwW5K9DB8mm1xW4dXMN7ZLslwU",
  authDomain: "kmtrack-e6c8e.firebaseapp.com",
  projectId: "kmtrack-e6c8e",
  storageBucket: "kmtrack-e6c8e.firebasestorage.app",
  messagingSenderId: "183667299645",
  appId: "1:183667299645:web:96690634f91899625de154",
  measurementId: "G-T62DEYPCY7"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const googleProvider = new GoogleAuthProvider();

let currentUser = null;
let isSyncing = false;

/* ==========================================
   PWA — SERVICE WORKER REGISTRATION
   ========================================== */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js?v=2')
      .then(reg => {
        console.log('[PWA] Service Worker registrado:', reg.scope);
        // Detect update
        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          installingWorker.onstatechange = () => {
            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New content available, force refresh after a delay or just prompt
              toast('Nova versão disponível! Atualizando...', 'info');
              setTimeout(() => {
                window.location.reload();
              }, 2000);
            }
          };
        };
      })
      .catch(err => console.warn('[PWA] Falha ao registrar SW:', err));
  });

  // Ensure refresh on new worker activation
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

/* ==========================================
   PWA INSTALLATION LOGIC
   ========================================== */

let deferredPrompt;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

window.addEventListener('appinstalled', () => {
  const banner = document.getElementById('installBanner');
  if (banner) banner.style.display = 'none';
  deferredPrompt = null;
  toast('KM Track instalado com sucesso! 🎉', 'success');
});

function initPWA() {
  const banner = document.getElementById('installBanner');
  const btnInstall = document.getElementById('btnInstallApp');
  const btnDismiss = document.getElementById('btnDismissInstall');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });

  if (btnDismiss) btnDismiss.addEventListener('click', () => {
    banner.style.display = 'none';
    localStorage.setItem('pwaDismissed', 'true');
  });

  if (btnInstall) btnInstall.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        banner.style.display = 'none';
      }
      deferredPrompt = null;
    } else if (isIOS) {
       alert("No Safari, toque no ícone de Compartilhar (caixa com seta) e depois escolha 'Adicionar à Tela de Início'.");
    }
  });
}

function suggestInstall() {
  if (isStandalone || localStorage.getItem('pwaDismissed') === 'true') return;

  // Aguarda 1.5s após o login para ser menos invasivo
  setTimeout(() => {
    const banner = document.getElementById('installBanner');
    if (!banner) return;
    
    // Só exibe se o navegador permitiu (deferredPrompt) ou se for um iPhone/iPad
    if (deferredPrompt || isIOS) {
      banner.style.display = 'flex';
      
      // Ajuste de texto para usuários iOS (Apple não permite prompt automático)
      if (isIOS) {
        const title = banner.querySelector('.install-text strong');
        const desc = banner.querySelector('.install-text span');
        if (title) title.textContent = 'Instale no seu iPhone';
        if (desc) desc.textContent = 'Toque em Compartilhar -> Adicionar à Tela de Início';
        
        const btnInstall = document.getElementById('btnInstallApp');
        if (btnInstall) btnInstall.textContent = 'Como Instalar';
      }
    }
  }, 1500);
}

/* ==========================================
   STATE & STORAGE
   ========================================== */

const STORAGE_KEY = 'kmtrack_data';

function defaultState() {
  return {
    vehicles: [],
    fuelLogs: [],
    kmLogs: [],
    theme: 'dark',
    activeVehicleId: null,
    trash: [], 
    onboardingComplete: false
  };
}

let state = defaultState();

function normalizeFuelLog(log) {
  if (!log || typeof log !== 'object') return null;
  const litersValue = Number(log.liters || log.litros || 0);
  return {
    ...log,
    litros: litersValue,
    liters: litersValue,
    kmTotal: Number(log.kmTotal || log.km || 0),
    tanqueCheio: !!(log.tanqueCheio || log.tankCheio),
  };
}

function normalizeFuelLogs(logs = []) {
  if (!Array.isArray(logs)) return [];
  return logs.map(normalizeFuelLog).filter(Boolean);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      state = { ...defaultState(), ...JSON.parse(raw) };
      state.fuelLogs = normalizeFuelLogs(state.fuelLogs);
      state.trash = Array.isArray(state.trash) ? state.trash : [];
    }
  } catch (e) { console.warn('Failed to load state', e); }
}

function saveState() {
  try { 
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); 
    // Trigger cloud sync in background if logged in
    syncToCloud();
  }
  catch (e) { console.warn('Failed to save state', e); }
}

/* ==========================================
   FIREBASE SYNC LOGIC
   ========================================== */

async function syncToCloud() {
  if (!currentUser || isSyncing) return;
  
  updateSyncStatus('loading');
  isSyncing = true;
  try {
    const batch = writeBatch(db);
    const userId = currentUser.uid;

    // 1. Root User Doc (Settings)
    const userRef = doc(db, 'users', userId);
    batch.set(userRef, {
      activeVehicleId: state.activeVehicleId,
      updatedAt: Date.now(),
      // Clean up old format if it existed
      vehicles: null,
      fuelLogs: null,
      kmLogs: null
    }, { merge: true });

    // 2. Vehicles
    state.vehicles.forEach(v => {
      const vRef = doc(db, 'users', userId, 'vehicles', v.id);
      batch.set(vRef, v);
    });

    // 3. Fuel Logs (Syncing last 200 for performance/batch limit)
    state.fuelLogs.slice(0, 200).forEach(l => {
      const lRef = doc(db, 'users', userId, 'fuelLogs', l.id);
      batch.set(lRef, l);
    });

    // 4. KM Logs
    state.kmLogs.slice(0, 200).forEach(l => {
      const lRef = doc(db, 'users', userId, 'kmLogs', l.id);
      batch.set(lRef, l);
    });

    // 5. Trash Logs
    state.trash.slice(0, 50).forEach(t => {
      const tRef = doc(db, 'users', userId, 'trash', t.trashId);
      batch.set(tRef, t);
    });

    await batch.commit();
    updateSyncStatus('success');
  } catch (e) {
    console.error('Cloud sync failed', e);
    updateSyncStatus('error');
  } finally {
    isSyncing = false;
  }
}

async function loadFromCloud() {
  if (!currentUser) return;
  
  updateSyncStatus('loading');
  try {
    const userId = currentUser.uid;
    const userRef = doc(db, 'users', userId);
    
    // Fetch all collections in parallel
    const [userSnap, vSnap, fSnap, kSnap, tSnap] = await Promise.all([
      getDoc(userRef),
      getDocs(collection(db, 'users', userId, 'vehicles')),
      getDocs(collection(db, 'users', userId, 'fuelLogs')),
      getDocs(collection(db, 'users', userId, 'kmLogs')),
      getDocs(collection(db, 'users', userId, 'trash'))
    ]);
    
    // Detect Legacy Data Format (Old single document sync)
    if (userSnap.exists() && userSnap.data().vehicles && Array.isArray(userSnap.data().vehicles)) {
      console.log('[Firebase] Detectado formato antigo. Migrando...');
      await migrateLegacyData(userSnap.data());
      return loadFromCloud(); // Restart after migration
    }

    if (userSnap.exists() || !vSnap.empty) {
      const cloudVehicles = vSnap.docs.map(d => d.data());
      const cloudFuel = fSnap.docs.map(d => d.data());
      const cloudKm = kSnap.docs.map(d => d.data());
      const cloudTrash = (tSnap && !tSnap.empty) ? tSnap.docs.map(d => d.data()) : [];
      const cloudActiveId = userSnap.exists() ? userSnap.data().activeVehicleId : null;
      const cloudUpdatedAt = userSnap.exists() ? userSnap.data().updatedAt : 0;

      // Merge Logic: If cloud is newer OR local is effectively empty
      if (state.vehicles.length === 0 || cloudUpdatedAt > (state.updatedAt || 0)) {
        state = { 
          ...defaultState(), 
          vehicles: cloudVehicles,
          fuelLogs: normalizeFuelLogs(cloudFuel),
          kmLogs: cloudKm,
          trash: cloudTrash,
          activeVehicleId: cloudActiveId || cloudVehicles[0]?.id || null,
          updatedAt: cloudUpdatedAt
        };
        
        // Sort logs by date descending
        state.fuelLogs.sort((a, b) => b.date.localeCompare(a.date));
        state.kmLogs.sort((a, b) => b.date.localeCompare(a.date));

        saveState(); // Update local storage (without triggering sync again)
        renderAll();
        toast('Dados sincronizados da nuvem.', 'success');
        
        // Prompt for first vehicle ONLY if really empty after cloud sync
        if (state.vehicles.length === 0) {
          setTimeout(() => openVehicleModal(), 800);
        }
      } else {
        // Local is newer, push to cloud
        syncToCloud();
      }
      updateSyncStatus('success');
    } else {
      // New user or empty cloud, upload current local state
      syncToCloud();
    }
  } catch (e) {
    console.error('Failed to load from cloud', e);
    updateSyncStatus('error');
  }
}

async function migrateLegacyData(oldData) {
  toast('Migrando dados para novo formato...', 'info');
  const batch = writeBatch(db);
  const userId = currentUser.uid;

  // Move vehicles
  if (oldData.vehicles) {
    oldData.vehicles.forEach(v => {
      batch.set(doc(db, 'users', userId, 'vehicles', v.id), v);
    });
  }
  // Move Fuel
  if (oldData.fuelLogs) {
    oldData.fuelLogs.forEach(l => {
      batch.set(doc(db, 'users', userId, 'fuelLogs', l.id), l);
    });
  }
  // Move KM
  if (oldData.kmLogs) {
    oldData.kmLogs.forEach(l => {
      batch.set(doc(db, 'users', userId, 'kmLogs', l.id), l);
    });
  }

  // Clear legacy fields and update root
  batch.set(doc(db, 'users', userId), {
    activeVehicleId: oldData.activeVehicleId || null,
    updatedAt: oldData.updatedAt || Date.now(),
    // Clear out old fields
    vehicles: null,
    fuelLogs: null,
    kmLogs: null
  }, { merge: true });

  await batch.commit();
}

function updateSyncStatus(status) {
  const badge = document.getElementById('syncStatusBadge');
  if (!badge) return;

  badge.className = 'badge ' + (status === 'success' ? 'badge-primary' : '');
  
  if (status === 'loading') {
    badge.textContent = '⏳ Sincronizando...';
  } else if (status === 'success') {
    badge.textContent = '✅ Sincronizado';
  } else if (status === 'error') {
    badge.textContent = '❌ Erro de Sincronia';
    badge.classList.add('badge-danger'); // Assuming we add a badge-danger class if needed
  }
}

/* ==========================================
   FIREBASE AUTH LOGIC
   ========================================== */

async function loginWithGoogle() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    console.error('Login failed', e);
    toast('Falha ao entrar com Google.', 'error');
  }
}

async function logout() {
  try {
    await signOut(auth);
    state = defaultState();
    saveState();
    window.location.reload(); // Reset app state
  } catch (e) {
    console.error('Logout failed', e);
  }
}

// Auth State Observer
onAuthStateChanged(auth, (user) => {
  const loginScreen = document.getElementById('login-screen');
  const appShell = document.getElementById('app');
  const profileContainer = document.getElementById('profileHeaderContainer');
  const avatar = document.getElementById('headerProfilePic');

  if (user) {
    currentUser = user;
    if (loginScreen) loginScreen.style.display = 'none';
    if (appShell) appShell.style.display = 'block';

    // Update Header Avatar
    if (avatar && user.photoURL) {
      avatar.src = user.photoURL;
      avatar.style.display = 'block';
    }

    // Update Settings Profile Header
    if (profileContainer) {
      profileContainer.innerHTML = `
        <div class="profile-header">
          <img src="${user.photoURL || ''}" class="profile-photo-large" alt="Foto" style="${!user.photoURL ? 'display:none;' : ''}"/>
          <div class="profile-info-large">
            <span class="profile-name-large">${escHtml(user.displayName)}</span>
            <span class="profile-email-large">${escHtml(user.email)}</span>
          </div>
        </div>
      `;
    }
    loadFromCloud();
  } else {
    currentUser = null;
    if (loginScreen) loginScreen.style.display = 'flex';
    if (appShell) appShell.style.display = 'none';
    if (profileContainer) profileContainer.innerHTML = '';
    if (avatar) avatar.style.display = 'none';
  }
});

function renderAll() {
  renderDashboard();
  renderVehicles();
  renderHistory();
  renderSettings();
  renderKmToday();
}

/* ==========================================
   HELPERS
   ========================================== */

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function fmt(n) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n || 0); }

function fmtNum(n, d = 0) { return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0); }

function todayStr() { return new Date().toISOString().split('T')[0]; }

function formatDate(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  return `${d}/${m}/${y}`;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function getMonthStr(date) {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function currentMonthKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

function fuelEmoji(type) {
  const map = { gasolina: '⛽', alcool: '🌿', diesel: '🚚', gnv: '💨' };
  return map[type] || '⛽';
}

function fuelLabel(type) {
  const labels = { gasolina: 'Gasolina', alcool: 'Álcool', diesel: 'Diesel', gnv: 'GNV' };
  return labels[type] || 'Outro';
}

function purposeLabel(p) {
  const labels = {
    trabalho: 'Trabalho',
    pessoal: 'Pessoal',
    viagem: 'Viagem',
    outro: 'Outro'
  };
  return labels[p] || 'Particular';
}

function purposeIcon(p) {
  const map = { pessoal: '🏠', trabalho: '💼', viagem: '✈️', outros: '📦' };
  return map[p] || '📍';
}

/* ==========================================
   ACTIVE VEHICLE
   ========================================== */

function getActiveVehicle() {
  return state.vehicles.find(v => v.id === state.activeVehicleId) || null;
}

function setActiveVehicle(id) {
  state.activeVehicleId = id;
  saveState();
  updateVehicleUI();
  renderDashboard();
  renderVehicles(); // Ensure vehicle list updates badges and buttons
  toast('Veículo alterado!', 'success');
}

function getVehicleLogs(vehicleId) {
  return {
    fuel: state.fuelLogs.filter(l => l.vehicleId === vehicleId),
    km: state.kmLogs.filter(l => l.vehicleId === vehicleId),
  };
}

/* ==========================================
   NAVIGATION
   ========================================== */

let currentPage = 'dashboard';

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-item').forEach(n => n.classList.remove('active'));

  const el = document.getElementById(`page-${page}`);
  if (el) el.classList.add('active');
  const navEl = document.getElementById(`nav-${page}`);
  if (navEl) navEl.classList.add('active');

  currentPage = page;

  // Re-render relevant page
  if (page === 'dashboard') renderDashboard();
  if (page === 'history') renderHistory();
  if (page === 'vehicles') renderVehicles();
  if (page === 'stats') renderStats();
  if (page === 'settings') renderSettings();
  // Reset scroll
  window.scrollTo(0, 0);
}


/* ==========================================
   TOAST
   ========================================== */

function toast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const t = document.createElement('div');
  const emoj = type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️');
  
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span>${emoj} ${msg}</span>`;
  container.appendChild(t);
  
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 500);
  }, 3000);
}

/* ==========================================
   CONFIRM MODAL
   ========================================== */

let confirmCallback = null;

function openConfirm(title, message, onOk) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  confirmCallback = onOk;
  document.getElementById('confirmModalBackdrop').classList.add('open');
}
function closeConfirm() {
  document.getElementById('confirmModalBackdrop').classList.remove('open');
  confirmCallback = null;
}

/* ==========================================
   VEHICLE MODAL
   ========================================== */

function openVehicleModal(vehicleOrId) {
  let vehicle = vehicleOrId;
  if (typeof vehicleOrId === 'string') {
    vehicle = state.vehicles.find(v => v.id === vehicleOrId);
  }

  const form = document.getElementById('vehicleForm');
  form.reset();

  if (vehicle) {
    document.getElementById('vehicleModalTitle').textContent = 'Editar Veículo';
    document.getElementById('vehicleId').value = vehicle.id;
    document.getElementById('vehicleName').value = vehicle.name;
    document.getElementById('vehicleBrand').value = vehicle.brand || '';
    document.getElementById('vehicleModel').value = vehicle.model || '';
    document.getElementById('vehicleYear').value = vehicle.year || '';
    document.getElementById('vehiclePlate').value = vehicle.plate || '';
    document.getElementById('vehicleKmInitial').value = vehicle.kmInitial || 0;
    document.getElementById('vehicleNextOil').value = vehicle.nextOilKm || '';
    document.getElementById('vehicleIpvaDate').value = vehicle.ipvaDate || '';
    document.getElementById('vehicleInsuranceDate').value = vehicle.insuranceDate || '';
    document.getElementById('vehicleLicenseDate').value = vehicle.licenseDate || '';
    document.getElementById('vehicleIcon').value = vehicle.icon || '🚗';
    // Update icon picker
    document.querySelectorAll('.icon-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.icon === vehicle.icon);
    });
  } else {
    document.getElementById('vehicleModalTitle').textContent = 'Adicionar Veículo';
    document.getElementById('vehicleId').value = '';
    document.getElementById('vehicleIcon').value = '🚗';
    document.getElementById('vehicleNextOil').value = '';
    document.querySelectorAll('.icon-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  }

  document.getElementById('vehicleModalBackdrop').classList.add('open');
}

function closeVehicleModal() {
  document.getElementById('vehicleModalBackdrop').classList.remove('open');
}

/* ==========================================
   VEHICLE CRUD
   ========================================== */

function saveVehicle(e) {
  e.preventDefault();
  const id = document.getElementById('vehicleId').value;
  const vehicle = {
    id: id || uid(),
    name: document.getElementById('vehicleName').value.trim(),
    brand: document.getElementById('vehicleBrand').value.trim(),
    model: document.getElementById('vehicleModel').value.trim(),
    year: document.getElementById('vehicleYear').value,
    plate: document.getElementById('vehiclePlate').value.trim().toUpperCase(),
    kmInitial: parseFloat(document.getElementById('vehicleKmInitial').value) || 0,
    nextOilKm: parseFloat(document.getElementById('vehicleNextOil').value) || null,
    ipvaDate: document.getElementById('vehicleIpvaDate').value,
    insuranceDate: document.getElementById('vehicleInsuranceDate').value,
    licenseDate: document.getElementById('vehicleLicenseDate').value,
    icon: document.getElementById('vehicleIcon').value,
    createdAt: id ? (state.vehicles.find(v => v.id === id)?.createdAt || Date.now()) : Date.now(),
  };

  if (!vehicle.name) { toast('Informe o nome do veículo.', 'error'); return; }

  if (id) {
    const idx = state.vehicles.findIndex(v => v.id === id);
    if (idx !== -1) state.vehicles[idx] = vehicle;
  } else {
    state.vehicles.push(vehicle);
    if (!state.activeVehicleId) state.activeVehicleId = vehicle.id;
  }

  saveState();
  closeVehicleModal();
  renderVehicles();
  updateVehicleUI();
  renderDashboard();
  toast(id ? 'Veículo atualizado!' : 'Veículo adicionado!', 'success');
}

function deleteVehicle(id) {
  const v = state.vehicles.find(v => v.id === id);
  if (!v) return;

  openConfirm('Mover para Lixeira', `Deseja mover "${v.name}" para a lixeira? Seus registros também serão ocultados.`, async () => {
    // Collect related logs to trash together
    const relatedFuel = state.fuelLogs.filter(l => l.vehicleId === id);
    const relatedKm = state.kmLogs.filter(l => l.vehicleId === id);

    const trashItem = {
      trashId: 'tr_' + Date.now() + Math.random().toString(36).substr(2, 5),
      type: 'vehicle',
      data: v,
      relatedData: { fuel: relatedFuel, km: relatedKm },
      deletedAt: new Date().toISOString()
    };

    state.trash.push(trashItem);
    state.vehicles = state.vehicles.filter(v => v.id !== id);
    state.fuelLogs = state.fuelLogs.filter(l => l.vehicleId !== id);
    state.kmLogs = state.kmLogs.filter(l => l.vehicleId !== id);

    if (state.activeVehicleId === id) {
      state.activeVehicleId = state.vehicles.length > 0 ? state.vehicles[0].id : null;
    }

    saveState();
    if (currentUser) {
      try {
        const batch = writeBatch(db);
        const userId = currentUser.uid;
        batch.delete(doc(db, "users", userId, "vehicles", id));
        // Note: we don't delete logs from DB here for speed, they just won't show 
        // until restored or unless we batch delete them. 
        // Safest is to batch delete them too.
        relatedFuel.forEach(l => batch.delete(doc(db, "users", userId, "fuelLogs", l.id)));
        relatedKm.forEach(l => batch.delete(doc(db, "users", userId, "kmLogs", l.id)));
        await batch.commit();
      } catch (e) { console.error('Cloud trash sync error', e); }
    }
    
    renderVehicles();
    renderDashboard();
    syncToCloud(); 
    toast('Veículo movido para a lixeira 🗑️', 'info');
  });
}

function renderVehicles() {
  const container = document.getElementById('vehicleList');
  if (!state.vehicles.length) {
    container.innerHTML = '<div class="empty-state"><span>🚗</span><p>Nenhum veículo cadastrado.<br>Clique em "Adicionar" para começar.</p></div>';
    return;
  }

  container.innerHTML = state.vehicles.map(v => {
    const isActive = v.id === state.activeVehicleId;
    const logs = getVehicleLogs(v.id);
    const totalSpent = logs.fuel.reduce((s, l) => s + (l.totalCost || 0), 0);
    const totalFills = logs.fuel.length;

    return `<div class="vehicle-card ${isActive ? 'active-vehicle' : ''}">
      <div class="vehicle-card-icon">${v.icon || '🚗'}</div>
      <div class="vehicle-card-info">
        <div class="vehicle-card-name">
          ${escHtml(v.name)}
          ${isActive ? '<span class="active-tag">Ativo</span>' : ''}
        </div>
        <div class="vehicle-card-sub">
          ${v.plate ? `<span>🪪 ${escHtml(v.plate)}</span>` : ''}
          ${v.year ? `<span>📅 ${v.year}</span>` : ''}
          <span>⛽ ${totalFills} abastecimentos</span>
          <span>💰 ${fmt(totalSpent)}</span>
        </div>
      </div>
      <div class="vehicle-card-actions">
        ${!isActive ? `<button class="btn btn-sm btn-primary" onclick="setActiveVehicle('${v.id}')">Usar</button>` : ''}
        <button class="btn btn-sm btn-secondary" onclick="openVehicleModal('${v.id}')" title="Editar">✏️</button>
        <button class="btn btn-sm btn-ghost" onclick="deleteVehicle('${v.id}')" title="Remover">🗑️</button>
      </div>
    </div>`;
  }).join('');

}

/* ==========================================
   UPDATE VEHICLE UI
   ========================================== */

function updateVehicleUI() {
  const v = getActiveVehicle();
  const icon = v ? v.icon : '🚗';

  // Update header right button (iOS style)
  const headerIcon = document.getElementById('iosVehicleIcon');
  if (headerIcon) headerIcon.textContent = icon;

  // Quick select buttons (if present)
  const qs = document.getElementById('qsButtons');
  if (qs) {
    qs.innerHTML = state.vehicles.map(veh => `
      <button class="qs-btn ${veh.id === state.activeVehicleId ? 'active' : ''}" onclick="setActiveVehicle('${veh.id}')">
        ${veh.icon || '🚗'} ${escHtml(veh.name)}
      </button>
    `).join('');
  }
}

/* ==========================================
   FUEL LOG CRUD
   ========================================== */

function saveFuel(e) {
  e.preventDefault();

  if (!state.activeVehicleId) {
    toast('Selecione um veículo primeiro!', 'error');
    navigateTo('vehicles');
    return;
  }

  const mode = document.querySelector('input[name="fuelInputMode"]:checked').value;
  let liters, ppl, total;

  if (mode === 'liters') {
    liters = parseFloat(document.getElementById('fuelLiters').value) || 0;
    ppl = parseFloat(document.getElementById('fuelPricePerLiter').value) || 0;
    total = liters * ppl;
  } else {
    total = parseFloat(document.getElementById('fuelTotalCost').value) || 0;
    ppl = parseFloat(document.getElementById('fuelPricePerLiterTotal').value) || 0;
    liters = total / ppl;
  }

  const date = document.getElementById('fuelDate').value;
  const kmTotal = parseFloat(document.getElementById('fuelKmTotal').value) || 0;
  const tanqueCheio = document.getElementById('fuelTankFull').checked;

  if (!date) { toast('Informe a data.', 'error'); return; }
  if (!kmTotal) { toast('Informe o KM do odômetro.', 'error'); return; }
  if (liters <= 0) { toast('Quantidade inválida.', 'error'); return; }
  if (ppl <= 0) { toast('Preço por litro inválido.', 'error'); return; }
  if (total <= 0) { toast('Valor total inválido.', 'error'); return; }

  const editingId = document.getElementById('fuelEditId').value;
  const existingFuel = state.fuelLogs.filter(l => l.vehicleId === state.activeVehicleId && l.id !== editingId);
  const highestKm = existingFuel.reduce((max, l) => Math.max(max, Number(l.kmTotal || 0)), 0);
  
  // For edits, be more lenient with km validation
  if (!editingId && kmTotal <= highestKm) {
    toast('O odômetro deve ser maior que o último registro válido.', 'error');
    return;
  }

  const log = {
    id: editingId || uid(),
    vehicleId: state.activeVehicleId,
    date,
    kmTotal,
    fuelType: document.getElementById('selectedFuelType').value,
    liters,
    pricePerLiter: ppl,
    totalCost: total,
    station: document.getElementById('fuelStation').value.trim(),
    notes: document.getElementById('fuelNotes').value.trim(),
    tanqueCheio,
    location: null
  };

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      log.location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    });
  }
  log.createdAt = editingId ? (state.fuelLogs.find(l => l.id === editingId)?.createdAt || Date.now()) : Date.now();

  if (editingId) {
    const idx = state.fuelLogs.findIndex(l => l.id === editingId);
    if (idx !== -1) state.fuelLogs[idx] = log;
  } else {
    state.fuelLogs.unshift(log);
  }

  // Update vehicle initial km if larger
  // const v = state.vehicles.find(v => v.id === state.activeVehicleId);
  // if (v && kmTotal > (v.kmInitial || 0)) { v.kmInitial = kmTotal; }

  saveState();
  document.getElementById('fuelForm').reset();
  document.getElementById('fuelEditId').value = '';
  setupFuelFormDefaults();
  document.getElementById('calcPreview').style.display = 'none';
  updateFuelFormMode(false);
  toast(editingId ? 'Abastecimento atualizado!' : 'Abastecimento salvo!', 'success');
  renderDashboard();
  renderHistory();
}

async function deleteFuelLog(id) {
  const log = state.fuelLogs.find(l => l.id === id);
  if (!log) return;

  openConfirm('Excluir Abastecimento', 'Deseja mover este abastecimento para a lixeira? 🗑️', async () => {
    const trashId = 'tr_' + Date.now() + Math.random().toString(36).substr(2, 4);
    const trashItem = {
      trashId,
      type: 'fuel',
      data: log,
      deletedAt: new Date().toISOString()
    };

    state.trash.push(trashItem);
    state.fuelLogs = state.fuelLogs.filter(l => l.id !== id);
    
    saveState();
    if (currentUser) {
      try { await deleteDoc(doc(db, "users", currentUser.uid, "fuelLogs", id)); } catch(e){}
    }
    renderHistory();
    renderDashboard();
    syncToCloud();
    toast('Abastecimento movido para a lixeira 🗑️', 'info');
  });
}

/* ==========================================
   KM LOG CRUD
   ========================================== */

function saveKm(e) {
  e.preventDefault();

  if (!state.activeVehicleId) {
    toast('Selecione um veículo primeiro!', 'error');
    navigateTo('vehicles');
    return;
  }

  const date = document.getElementById('kmDate').value;
  let kmStart = parseFloat(document.getElementById('kmStart').value) || 0;
  const kmEnd = parseFloat(document.getElementById('kmEnd').value) || 0;

  if (!date) { toast('Informe a data.', 'error'); return; }

  // Auto-fill kmStart if empty and kmEnd is provided
  const editingId = document.getElementById('kmEditId').value;
  if (!editingId && kmEnd && !kmStart) {
    const v = getActiveVehicle();
    const currentVFuel = state.fuelLogs.filter(l => l.vehicleId === state.activeVehicleId);
    const currentVKm = state.kmLogs.filter(l => l.vehicleId === state.activeVehicleId);
    const allKms = [
      ...(currentVFuel.map(l => Number(l.kmTotal || 0))),
      ...(currentVKm.map(l => Number(l.kmEnd || 0))),
      (v ? Number(v.kmInitial || 0) : 0)
    ];
    kmStart = Math.max(...allKms, 0);
    // Optionally update the UI field so the user sees what happened
    document.getElementById('kmStart').value = kmStart;
  }

  if (!kmStart && !kmEnd) { toast('Informe pelo menos o KM inicial ou final.', 'error'); return; }
  if (kmEnd && kmStart && kmEnd < kmStart) { toast('KM final não pode ser menor que KM inicial.', 'error'); return; }

  const log = {
    id: editingId || uid(),
    vehicleId: state.activeVehicleId,
    date,
    kmStart,
    kmEnd,
    kmDiff: kmEnd - kmStart,
    purpose: document.getElementById('kmPurpose').value,
    notes: document.getElementById('kmNotes').value.trim(),
    createdAt: editingId ? (state.kmLogs.find(l => l.id === editingId)?.createdAt || Date.now()) : Date.now(),
  };

  if (editingId) {
    const idx = state.kmLogs.findIndex(l => l.id === editingId);
    if (idx !== -1) state.kmLogs[idx] = log;
  } else {
    state.kmLogs.unshift(log);
  }

  saveState();
  document.getElementById('kmForm').reset();
  document.getElementById('kmEditId').value = '';
  setupKmFormDefaults();
  document.getElementById('kmPreview').style.display = 'none';
  updateKmFormMode(false);
  toast(editingId ? 'Registro de KM atualizado!' : 'Registro de KM salvo!', 'success');
  renderKmToday();
  renderDashboard();
  renderHistory();
}

async function deleteKmLog(id) {
  const log = state.kmLogs.find(l => l.id === id);
  if (!log) return;

  openConfirm('Excluir KM', 'Deseja mover este registro de KM para a lixeira? 🗑️', async () => {
    const trashId = 'tr_' + Date.now() + Math.random().toString(36).substr(2, 4);
    const trashItem = {
      trashId,
      type: 'km',
      data: log,
      deletedAt: new Date().toISOString()
    };

    state.trash.push(trashItem);
    state.kmLogs = state.kmLogs.filter(l => l.id !== id);
    
    saveState();
    if (currentUser) {
      try { await deleteDoc(doc(db, "users", currentUser.uid, "kmLogs", id)); } catch(e){}
    }
    renderHistory();
    renderDashboard();
    renderKmToday();
    syncToCloud();
    toast('Registro de KM movido para a lixeira 🗑️', 'info');
  });
}

/* ==========================================
   DASHBOARD
   ========================================== */

function renderDashboard() {
  const today = todayStr();
  const mk = currentMonthKey();
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  document.getElementById('monthLabel').textContent = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  const v = getActiveVehicle();
  const vId = v?.id || null;

  console.log('renderDashboard - activeVehicleId:', state.activeVehicleId, 'vehicle:', v, 'vId:', vId);

  const vFuel = vId ? state.fuelLogs.filter(l => String(l.vehicleId) === String(vId)).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)) : [];
  const vKm = vId ? state.kmLogs.filter(l => String(l.vehicleId) === String(vId)).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)) : [];

  // Stats
  // Get latest KM by chronology (most recent date)
  let currentKm = v ? Number(v.kmInitial || 0) : 0;
  const lastFuel = vFuel[0];
  const lastKm = vKm[0];

  if (lastFuel && lastKm) {
    const fuelDate = lastFuel.date + (lastFuel.createdAt ? lastFuel.createdAt : '');
    const kmDate = lastKm.date + (lastKm.createdAt ? lastKm.createdAt : '');
    currentKm = fuelDate >= kmDate ? Number(lastFuel.kmTotal || 0) : Number(lastKm.kmTotal || 0);
  } else if (lastFuel) {
    currentKm = Number(lastFuel.kmTotal || 0);
  } else if (lastKm) {
    currentKm = Number(lastKm.kmTotal || 0);
  }

  const gastoTotal = vFuel.reduce((s, l) => s + Number(l.totalCost || 0), 0);
  const litrosTotal = vFuel.reduce((s, l) => s + Number(l.liters || 0), 0);

  document.getElementById('statKmTotal').textContent = fmtNum(currentKm) + ' km';
  document.getElementById('statGastoTotal').textContent = fmt(gastoTotal);
  document.getElementById('statLitrosTotal').textContent = fmtNum(litrosTotal, 1) + ' L';

  // Improved consumption logic: (Last Fuel KM - First Fuel KM) / (Liters from 2nd fill onwards)
  let mediaConsumo = -1;
  if (vFuel.length >= 2) {
    // vFuel is already sorted desc (newest first). Let's get asc.
    const vFuelAsc = [...vFuel].sort((a,b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    const firstFuel = vFuelAsc[0];
    const lastFuelEntry = vFuelAsc[vFuelAsc.length - 1];
    
    const distanceDelta = Number(lastFuelEntry.kmTotal || 0) - Number(firstFuel.kmTotal || 0);
    // Sum liters from second fill onwards (the fuel that filled the distance between first and last)
    const consumedLiters = vFuelAsc.slice(1).reduce((s, l) => s + Number(l.liters || 0), 0);
    
    if (distanceDelta > 0 && consumedLiters > 0) {
      mediaConsumo = distanceDelta / consumedLiters;
    }
  }
  document.getElementById('statMediaConsumo').textContent = mediaConsumo > 0 ? (fmtNum(mediaConsumo, 2) + ' km/L') : '— km/L';

  // Last fill
  const lastFill = vFuel[0];
  const lastFillCard = document.getElementById('lastFillCard');
  if (lastFill) {
    lastFillCard.innerHTML = `<div class="last-fill-info">
      <div class="last-fill-header">
        <div class="fuel-badge ${lastFill.fuelType}">${fuelEmoji(lastFill.fuelType)} ${fuelLabel(lastFill.fuelType)}</div>
        <div class="last-fill-date">${formatDate(lastFill.date)} ${formatTime(lastFill.createdAt || new Date(lastFill.date + 'T12:00:00').getTime())}</div>
      </div>
      
      <div class="last-fill-main">
        <div class="last-fill-item">
          <div class="last-fill-item-label">Litros</div>
          <div class="last-fill-item-value">${fmtNum(lastFill.liters, 2)} L</div>
        </div>
        <div class="last-fill-item">
          <div class="last-fill-item-label">Valor Total</div>
          <div class="last-fill-item-value">${fmt(lastFill.totalCost)}</div>
        </div>
      </div>
      
      <div class="last-fill-secondary">
        <div class="last-fill-row">
          <span class="last-fill-row-label">Preço por Litro</span>
          <span class="last-fill-row-value">${fmt(lastFill.pricePerLiter)}</span>
        </div>
        <div class="last-fill-row">
          <span class="last-fill-row-label">Odômetro</span>
          <span class="last-fill-row-value">${fmtNum(lastFill.kmTotal)} km</span>
        </div>
        ${lastFill.station ? `<div class="last-fill-row"><span class="last-fill-row-label">Posto</span><span class="last-fill-row-value">${escHtml(lastFill.station)}</span></div>` : ''}
        ${lastFill.tanqueCheio ? `<div class="last-fill-row"><span class="last-fill-row-label">Status</span><span class="last-fill-row-value">Tanque Cheio</span></div>` : ''}
      </div>
    </div>`;
  } else {
    lastFillCard.innerHTML = '<div class="empty-state"><span>⛽</span><p>Nenhum abastecimento registrado.</p></div>';
  }

  // KM today
  const kmToday = vKm.filter(l => l.date === today);
  const kmTodayCard = document.getElementById('kmTodayCard');
  if (kmToday.length) {
    const totalToday = kmToday.reduce((s, l) => s + (l.kmDiff || 0), 0);
    kmTodayCard.innerHTML = `<div class="last-fill-info">
      <div class="last-fill-header">
        <div style="font-size: 1.2rem; font-weight: 700; color: var(--success);">${fmtNum(totalToday)} km</div>
        <div class="last-fill-date">Total de hoje</div>
      </div>
      
      <div class="last-fill-secondary">
        ${kmToday.map(l => `<div class="last-fill-row">
          <span class="last-fill-row-label">${purposeIcon(l.purpose)} ${purposeLabel(l.purpose)}</span>
          <span class="last-fill-row-value">${fmtNum(l.kmDiff)} km</span>
        </div>`).join('')}
      </div>
    </div>`;
  } else {
    kmTodayCard.innerHTML = '<div class="empty-state"><span>📍</span><p>Nenhum registro de KM hoje.</p></div>';
  }

  // Monthly summary
  const monthFuel = vFuel.filter(l => l.date && l.date.startsWith(mk));
  const monthKm = vKm.filter(l => l.date && l.date.startsWith(mk));
  document.getElementById('msGasto').textContent = fmt(monthFuel.reduce((s, l) => s + (l.totalCost || 0), 0));
  document.getElementById('msLitros').textContent = fmtNum(monthFuel.reduce((s, l) => s + (l.liters || 0), 0), 1) + ' L';
  document.getElementById('msAbast').textContent = monthFuel.length;
  
  // Calculate Monthly KM Traveled (User Logic: Current KM - First KM of Month)
  let firstKmOfMonth = null;
  const firstFuel = monthFuel.length > 0 ? [...monthFuel].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0))[0] : null;
  const firstKmEntry = monthKm.length > 0 ? [...monthKm].sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0))[0] : null;

  if (firstFuel && firstKmEntry) {
    if (firstFuel.date <= firstKmEntry.date) {
      firstKmOfMonth = Number(firstFuel.kmTotal || 0);
    } else {
      firstKmOfMonth = Number(firstKmEntry.kmStart || firstKmEntry.kmEnd || 0);
    }
  } else if (firstFuel) {
    firstKmOfMonth = Number(firstFuel.kmTotal || 0);
  } else if (firstKmEntry) {
    firstKmOfMonth = Number(firstKmEntry.kmStart || firstKmEntry.kmEnd || 0);
  }

  const monthlyKm = firstKmOfMonth !== null ? Math.max(0, currentKm - firstKmOfMonth) : 0;
  document.getElementById('msKm').textContent = fmtNum(monthlyKm) + ' km';

  // Maintenance Alerts
  const dashSummary = document.querySelector('#page-dashboard .page-header');
  if (v && v.nextOilKm) {
    const currentKm = v.currentKm || 0;
    const remaining = v.nextOilKm - currentKm;
    if (remaining < 1000) {
      const isDanger = remaining <= 0;
      // Remove old alert if exists
      const oldAlert = document.getElementById('dash-maint-alert');
      if (oldAlert) oldAlert.remove();

      const alertDiv = document.createElement('div');
      alertDiv.id = 'dash-maint-alert';
      alertDiv.className = `maintenance-card ${isDanger ? 'danger' : ''}`;
      alertDiv.innerHTML = `
        <div class="maintenance-icon">${isDanger ? '🚨' : '⚠️'}</div>
        <div class="maintenance-text">
          <h4>${isDanger ? 'Troca de Óleo Vencida!' : 'Troca de Óleo Próxima'}</h4>
          <p>${isDanger ? 'Venceu há' : 'Faltam'} ${Math.abs(remaining)} km para o limite.</p>
        </div>
      `;
      dashSummary.after(alertDiv);
    } else {
      const oldAlert = document.getElementById('dash-maint-alert');
      if (oldAlert) oldAlert.remove();
    }
  }

  // Document Alerts (IPVA, Licensing, Insurance)
  if (v) {
    const today = new Date();
    const checkDoc = (dateStr, label) => {
      if (!dateStr) return;
      const d = new Date(dateStr);
      const diffDays = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
      if (diffDays <= 30) {
        const isExpired = diffDays <= 0;
        const alertId = `dash-doc-${label}`;
        if (document.getElementById(alertId)) return;
        const docAlert = document.createElement('div');
        docAlert.id = alertId;
        docAlert.className = `maintenance-card ${isExpired ? 'danger' : ''}`;
        docAlert.style.marginTop = '0.5rem';
        docAlert.innerHTML = `
          <div class="maintenance-icon">📄</div>
          <div class="maintenance-text">
            <h4>${label} ${isExpired ? 'Vencido' : 'Próximo'}</h4>
            <p>${isExpired ? 'Venceu em' : 'Vence em'} ${formatDate(dateStr)} (${diffDays} dias).</p>
          </div>
        `;
        dashSummary.after(docAlert);
      }
    };
    checkDoc(v.ipvaDate, 'IPVA');
    checkDoc(v.licenseDate, 'Licenciamento');
    checkDoc(v.insuranceDate, 'Seguro');
  }

  // Update vehicle selector
  updateVehicleUI();
}

/* ==========================================
   KM TODAY
   ========================================== */

function renderKmToday() {
  const today = todayStr();
  const vId = state.activeVehicleId;
  const logs = state.kmLogs.filter(l => l.vehicleId === vId && l.date === today);
  const container = document.getElementById('kmTodayList');

  if (!logs.length) {
    container.innerHTML = '<div class="empty-state"><span>📍</span><p>Nenhum registro ainda.</p></div>';
    return;
  }

  container.innerHTML = logs.map(l => `
    <div class="hist-item km-entry">
      <div class="hist-item-header">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span>${purposeIcon(l.purpose)} ${purposeLabel(l.purpose)}</span>
        </div>
        <span class="hist-item-cost" style="color:var(--primary-light);">+${fmtNum(l.kmDiff)} km</span>
      </div>
      <div class="hist-item-details">
        ${l.kmStart ? `<span class="hist-detail">Início: <span>${fmtNum(l.kmStart)} km</span></span>` : ''}
        ${l.kmEnd ? `<span class="hist-detail">Fim: <span>${fmtNum(l.kmEnd)} km</span></span>` : ''}
        ${l.notes ? `<span class="hist-detail">📝 <span>${escHtml(l.notes)}</span></span>` : ''}
      </div>
      <div class="hist-item-actions">
        <button class="hist-action-btn edit" onclick="editKmLog('${l.id}')" title="Editar">✏️</button>
        <button class="hist-action-btn" onclick="deleteKmLog('${l.id}')" title="Remover">🗑️</button>
      </div>
    </div>
  `).join('');
}

/* ==========================================
   HISTORY
   ========================================== */

let histTab = 'fuel-history';
let histFilterMonth = '';
let histFilterFuelType = '';

function renderHistory() {
  const vId = state.activeVehicleId;

  // Populate months filter
  const allMonths = new Set([
    ...state.fuelLogs.filter(l => l.vehicleId === vId).map(l => l.date?.slice(0, 7)),
    ...state.kmLogs.filter(l => l.vehicleId === vId).map(l => l.date?.slice(0, 7)),
  ].filter(Boolean));

  const monthSelect = document.getElementById('filterMonth');
  const currentVal = monthSelect.value;
  monthSelect.innerHTML = '<option value="">Todos os meses</option>' +
    [...allMonths].sort().reverse().map(m => {
      const [y, mo] = m.split('-');
      const label = new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      return `<option value="${m}" ${currentVal === m ? 'selected' : ''}>${label}</option>`;
    }).join('');

  renderFuelHistory(vId);
  renderKmHistory(vId);
}

function renderFuelHistory(vId) {
  let fuelLogs = state.fuelLogs.filter(l => l.vehicleId === vId).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  if (histFilterMonth) fuelLogs = fuelLogs.filter(l => l.date?.startsWith(histFilterMonth));
  if (histFilterFuelType) fuelLogs = fuelLogs.filter(l => l.fuelType === histFilterFuelType);

  const container = document.getElementById('fuelHistoryList');
  if (!fuelLogs.length) {
    container.innerHTML = '<div class="empty-state"><span>⛽</span><p>Nenhum registro encontrado.</p></div>';
    return;
  }

    container.innerHTML = fuelLogs.map(l => {
      const fullTankBadge = l.tanqueCheio ? '<span class="hist-badge full-tank">Tanque cheio</span>' : '';
      const stationHtml = l.station ? `<span class="hist-detail">⛽ <span>${escHtml(l.station)}</span></span>` : '';

      return `
      <div class="hist-item fuel-entry">
        <div class="hist-item-header">
          <div style="display:flex;align-items:center;gap:0.5rem;">
            <span class="fuel-badge ${l.fuelType}">${fuelEmoji(l.fuelType)} ${fuelLabel(l.fuelType)}</span>
            <span class="hist-item-date">${formatDate(l.date)} ${formatTime(l.createdAt || new Date(l.date + 'T12:00:00').getTime())}</span>
          </div>
          <span class="hist-item-cost">${fmt(l.totalCost)}</span>
        </div>
        <div class="hist-item-details">
          <span class="hist-detail">📍 <span>${fmtNum(l.kmTotal)} km</span></span>
          <span class="hist-detail">⛽ <span>${fmtNum(l.liters, 2)} L (${fmt(l.pricePerLiter)}/L)</span></span>
          ${stationHtml}
        </div>
        <div class="hist-item-tags">
          ${fullTankBadge}
        </div>
        <div class="hist-item-actions">
          <button class="btn btn-ghost btn-sm" onclick="editFuelLog('${l.id}')">✏️ Editar</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteFuelLog('${l.id}')">🗑️</button>
        </div>
      </div>
    `;
    }).join('');
}

function renderKmHistory(vId) {
  let logs = state.kmLogs.filter(l => l.vehicleId === vId).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  if (histFilterMonth) logs = logs.filter(l => l.date?.startsWith(histFilterMonth));

  const container = document.getElementById('kmHistoryList');
  if (!logs.length) {
    container.innerHTML = '<div class="empty-state"><span>📍</span><p>Nenhum registro de KM.</p></div>';
    return;
  }

  container.innerHTML = logs.map(l => `
    <div class="hist-item km-entry">
      <div class="hist-item-header">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span>${purposeLabel(l.purpose)}</span>
          <span class="hist-item-date">${formatDate(l.date)} ${formatTime(l.createdAt || new Date(l.date + 'T12:00:00').getTime())}</span>
        </div>
        <span class="hist-item-cost" style="color:var(--primary-light);">+${fmtNum(l.kmDiff)} km</span>
      </div>
      <div class="hist-item-details">
        ${l.kmStart ? `<span class="hist-detail">Início: <span>${fmtNum(l.kmStart)} km</span></span>` : ''}
        ${l.kmEnd ? `<span class="hist-detail">Fim: <span>${fmtNum(l.kmEnd)} km</span></span>` : ''}
        ${l.notes ? `<span class="hist-detail">📝 <span>${escHtml(l.notes)}</span></span>` : ''}
      </div>
      <div class="hist-item-actions">
        <button class="hist-action-btn edit" onclick="editKmLog('${l.id}')" title="Editar">✏️</button>
        <button class="hist-action-btn" onclick="deleteKmLog('${l.id}')" title="Remover">🗑️</button>
      </div>
    </div>
  `).join('');
}

/* ==========================================
   SETTINGS
   ========================================== */

function renderSettings() {
  const total = {
    vehicles: state.vehicles.length,
    fuelLogs: state.fuelLogs.length,
    kmLogs: state.kmLogs.length,
    trashCount: (state.trash || []).length,
    totalSpent: state.fuelLogs.reduce((s, l) => s + (l.totalCost || 0), 0),
    totalLiters: state.fuelLogs.reduce((s, l) => s + (l.liters || 0), 0),
  };

  const list = document.getElementById('settingsStatsList');
  if (!list) return;

  list.innerHTML = `
    <div class="settings-item">
      <div class="settings-item-left">
        <div class="settings-item-icon">🚗</div>
        <span class="settings-item-label">Veículos Ativos</span>
      </div>
      <div class="settings-item-right">${total.vehicles}</div>
    </div>
    <div class="settings-item">
      <div class="settings-item-left">
        <div class="settings-item-icon">⛽</div>
        <span class="settings-item-label">Abastecimentos</span>
      </div>
      <div class="settings-item-right">${total.fuelLogs}</div>
    </div>
    <div class="settings-item">
      <div class="settings-item-left">
        <div class="settings-item-icon">📍</div>
        <span class="settings-item-label">Registros de KM</span>
      </div>
      <div class="settings-item-right">${total.kmLogs}</div>
    </div>
    <div class="settings-item">
      <div class="settings-item-left">
        <div class="settings-item-icon">🗑️</div>
        <span class="settings-item-label">Lixeira</span>
      </div>
      <div class="settings-item-right">${total.trashCount} itens</div>
    </div>
    <div class="settings-item">
      <div class="settings-item-left">
        <div class="settings-item-icon">💰</div>
        <span class="settings-item-label">Total Gasto</span>
      </div>
      <div class="settings-item-right">${fmt(total.totalSpent)}</div>
    </div>
  `;
}

/* ==========================================
   BACKUP — EXPORT / IMPORT
   ========================================== */

function exportData() {
  const data = { ...state, exportedAt: new Date().toISOString(), version: 1 };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kmtrack_backup_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup exportado com sucesso!', 'success');
}



// Settings / Stats buttons

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.vehicles || !data.fuelLogs) throw new Error('Formato inválido');
      openConfirm('Importar dados', 'Isso irá substituir todos os dados atuais. Continuar?', () => {
        state = { ...defaultState(), ...data };
        delete state.exportedAt;
        delete state.version;
        saveState();
        renderDashboard();
        renderVehicles();
        renderSettings();
        toast('Dados importados com sucesso!', 'success');
      });
    } catch (err) {
      toast('Arquivo inválido ou corrompido.', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function clearAllData() {
  openConfirm('Limpar todos os dados', 'ATENÇÃO: Esta ação é irreversível! Todos os dados serão apagados permanentemente.', () => {
    state = defaultState();
    saveState();
    renderDashboard();
    renderVehicles();
    renderSettings();
    updateVehicleUI();
    toast('Todos os dados foram apagados.', 'info');
  });
}

/* ==========================================
   EDIT HELPERS
   ========================================== */

function editFuelLog(id) {
  const log = state.fuelLogs.find(l => l.id === id);
  if (!log) return;

  // Update stats if on stats page
  if (currentPage === 'stats') renderStats();

  // Navigate to register page
  navigateTo('register');

  // Fill form with log data
  document.getElementById('fuelEditId').value = log.id;
  document.getElementById('fuelDate').value = log.date;
  document.getElementById('fuelKmTotal').value = log.kmTotal || '';
  document.getElementById('fuelLiters').value = log.liters || '';
  document.getElementById('fuelPricePerLiter').value = log.pricePerLiter || '';
  document.getElementById('fuelPricePerLiterTotal').value = log.pricePerLiter || '';
  document.getElementById('fuelTotalCost').value = log.totalCost || '';
  document.getElementById('fuelStation').value = log.station || '';
  document.getElementById('fuelNotes').value = log.notes || '';
  document.getElementById('fuelTankFull').checked = !!log.tanqueCheio;

  // Set fuel type
  document.getElementById('selectedFuelType').value = log.fuelType || 'gasolina';
  document.querySelectorAll('.fuel-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === log.fuelType);
  });

  // Set input mode to liters for editing
  const litersRadio = document.querySelector('input[name="fuelInputMode"][value="liters"]');
  if (litersRadio) litersRadio.checked = true;
  document.getElementById('litersMode').style.display = 'flex';
  document.getElementById('totalMode').style.display = 'none';
  document.getElementById('fuelLiters').required = true;
  document.getElementById('fuelTotalCost').required = false;
  document.getElementById('fuelPricePerLiter').required = true;
  document.getElementById('fuelPricePerLiterTotal').required = false;

  updateFuelFormMode(true);
  recalcFuelCost();

  // Scroll to top of form
  document.getElementById('page-register').scrollIntoView({ behavior: 'smooth' });
}

function editKmLog(id) {
  const log = state.kmLogs.find(l => l.id === id);
  if (!log) return;

  navigateTo('km');

  document.getElementById('kmEditId').value = log.id;
  document.getElementById('kmDate').value = log.date;
  document.getElementById('kmStart').value = log.kmStart || '';
  document.getElementById('kmEnd').value = log.kmEnd || '';
  document.getElementById('kmPurpose').value = log.purpose || 'pessoal';
  document.getElementById('kmNotes').value = log.notes || '';

  updateKmFormMode(true);
  recalcKmDiff();

  document.getElementById('page-km').scrollIntoView({ behavior: 'smooth' });
}

function updateFuelFormMode(isEditing) {
  const title = document.querySelector('#page-register .page-title');
  const subtitle = document.querySelector('#page-register .page-subtitle');
  const btn = document.getElementById('btnSaveFuel');
  const cancelBtn = document.getElementById('btnCancelEditFuel');

  if (isEditing) {
    title.textContent = 'Editar Abastecimento';
    subtitle.textContent = 'Atualize os dados do abastecimento';
    btn.textContent = '💾 Atualizar Abastecimento';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  } else {
    title.textContent = 'Registrar Abastecimento';
    subtitle.textContent = 'Informe os dados do abastecimento';
    btn.textContent = '💾 Salvar Abastecimento';
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

function updateKmFormMode(isEditing) {
  const title = document.querySelector('#page-km .page-title');
  const subtitle = document.querySelector('#page-km .page-subtitle');
  const btn = document.getElementById('btnSaveKm');
  const cancelBtn = document.getElementById('btnCancelEditKm');

  if (isEditing) {
    title.textContent = 'Editar Registro de KM';
    subtitle.textContent = 'Atualize os dados do registro';
    btn.textContent = '💾 Atualizar Registro';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  } else {
    title.textContent = 'Registro de KM';
    subtitle.textContent = 'Registre a quilometragem diária';
    btn.textContent = '💾 Salvar Registro';
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}

/* ==========================================
   FORM UTILITIES
   ========================================== */

function setupFuelFormDefaults() {
  document.getElementById('fuelDate').value = todayStr();
  document.getElementById('selectedFuelType').value = 'gasolina';
  document.getElementById('fuelTankFull').checked = false;
  document.querySelectorAll('.fuel-btn').forEach((b, i) => b.classList.toggle('active', i === 0));

  // Reset input mode to liters
  const litersRadio = document.querySelector('input[name="fuelInputMode"][value="liters"]');
  if (litersRadio) litersRadio.checked = true;
  document.getElementById('litersMode').style.display = 'flex';
  document.getElementById('totalMode').style.display = 'none';
  document.getElementById('fuelLiters').required = true;
  document.getElementById('fuelTotalCost').required = false;
  document.getElementById('fuelPricePerLiter').required = true;
  document.getElementById('fuelPricePerLiterTotal').required = false;

  // Pre-fill odometer with last known KM
  if (state.activeVehicleId) {
    const v = getActiveVehicle();
    if (v && v.kmInitial) {
      document.getElementById('fuelKmTotal').value = v.kmInitial;
    }
  }
}

function setupKmFormDefaults() {
  document.getElementById('kmDate').value = todayStr();
  // Pre-fill start km from last fuel odometer
  if (state.activeVehicleId) {
    const v = getActiveVehicle();
    if (v && v.kmInitial) {
      document.getElementById('kmStart').value = v.kmInitial;
    }
  }
}

function recalcFuelCost() {
  const mode = document.querySelector('input[name="fuelInputMode"]:checked').value;
  let totalCost = 0;

  if (mode === 'liters') {
    const liters = parseFloat(document.getElementById('fuelLiters').value) || 0;
    const ppl = parseFloat(document.getElementById('fuelPricePerLiter').value) || 0;
    if (liters > 0 && ppl > 0) {
      totalCost = liters * ppl;
    }
  } else {
    totalCost = parseFloat(document.getElementById('fuelTotalCost').value) || 0;
  }

  // Calc cost per km estimate
  const km = parseFloat(document.getElementById('fuelKmTotal').value) || 0;
  const v = getActiveVehicle();
  const prevKm = v ? (v.kmInitial || 0) : 0;

  const prev = document.getElementById('calcPreview');
  if (totalCost > 0 && km > prevKm) {
    const diff = km - prevKm;
    const perKm = totalCost / diff;
    document.getElementById('calcCostPerKm').textContent = fmt(perKm) + '/km';
    prev.style.display = 'block';
  } else {
    prev.style.display = 'none';
  }
}

function recalcKmDiff() {
  const s = parseFloat(document.getElementById('kmStart').value) || 0;
  const e = parseFloat(document.getElementById('kmEnd').value) || 0;
  const prev = document.getElementById('kmPreview');
  if (s > 0 || e > 0) {
    const diff = e - s;
    document.getElementById('kmDiffValue').textContent = (diff >= 0 ? '+' : '') + fmtNum(diff) + ' km';
    prev.style.display = 'flex';
  } else {
    prev.style.display = 'none';
  }
}

/* ==========================================
   XSS PROTECTION
   ========================================== */

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ==========================================
   STATISTICS & CHARTS
   ========================================== */
let consumptionChart = null;
let expensesChart = null;

function renderStats() {
  const vId = state.activeVehicleId;
  const v = getActiveVehicle();
  if (!v || !vId) return;

  const vFuel = state.fuelLogs.filter(l => l.vehicleId === vId).sort((a,b) => a.date.localeCompare(b.date));
  
  // Consumption Chart Data
  const consumptionData = [];
  const consumptionLabels = [];
  
  if (vFuel.length >= 2) {
    for (let i = 1; i < vFuel.length; i++) {
      const kmDiff = vFuel[i].kmTotal - vFuel[i-1].kmTotal;
      const liters = vFuel[i].liters;
      if (kmDiff > 0 && typeof liters === 'number' && liters > 0) {
        consumptionData.push((kmDiff / liters).toFixed(2));
        consumptionLabels.push(formatDate(vFuel[i].date));
      }
    }
  }

  // Expenses Chart Data (Last 6 months)
  const expenseMap = {};
  const today = new Date();
  const mkKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    expenseMap[mkKey(d)] = 0;
  }
  
  vFuel.forEach(l => {
    const key = l.date.slice(0, 7);
    if (expenseMap[key] !== undefined) {
      expenseMap[key] += (l.totalCost || 0);
    }
  });

  const expenseLabels = Object.keys(expenseMap).reverse().map(k => {
    const [y, m] = k.split('-');
    return new Date(y, m-1, 1).toLocaleDateString('pt-BR', { month: 'short' });
  });
  const expenseValues = Object.values(expenseMap).reverse();

  // Create/Update Charts
  const ctxCons = document.getElementById('chartConsumption')?.getContext('2d');
  if (ctxCons) {
    if (consumptionChart) consumptionChart.destroy();
    consumptionChart = new Chart(ctxCons, {
      type: 'line',
      data: {
        labels: consumptionLabels,
        datasets: [{
          label: 'km/L',
          data: consumptionData,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true,
          tension: 0.4
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }

  const ctxExp = document.getElementById('chartExpenses')?.getContext('2d');
  if (ctxExp) {
    if (expensesChart) expensesChart.destroy();
    expensesChart = new Chart(ctxExp, {
      type: 'bar',
      data: {
        labels: expenseLabels,
        datasets: [{
          label: 'Gastos R$',
          data: expenseValues,
          backgroundColor: '#10b981',
          borderRadius: 6
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }
}

function exportToExcel() {
  const v = getActiveVehicle();
  if (!v) { toast('Selecione um veículo!', 'error'); return; }

  const fuelData = state.fuelLogs.filter(l => l.vehicleId === v.id).map(l => ({
    Data: formatDate(l.date),
    Combustivel: fuelLabel(l.fuelType),
    Litros: l.liters,
    'Preco/L': l.pricePerLiter,
    Total: l.totalCost,
    Odometro: l.kmTotal,
    Posto: l.station || ''
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(fuelData);
  XLSX.utils.book_append_sheet(wb, ws, "Abastecimentos");
  XLSX.writeFile(wb, `KM_Track_${v.name}.xlsx`);
  toast('Exportação concluída!', 'success');
}

function calculateFlex() {
  const pg = parseFloat(document.getElementById('flexPriceGas').value) || 0;
  const pa = parseFloat(document.getElementById('flexPriceAlc').value) || 0;
  
  const visual = document.getElementById('flexVisualArea');
  const fill = document.getElementById('flexGaugeFill');
  const verd = document.getElementById('flexVerdict');
  const reas = document.getElementById('flexReasoning');
  const card = document.querySelector('.flex-result-card');

  if (!pg || !pa) {
    visual.style.display = 'none';
    return;
  }
  
  const ratio = pa / pg;
  visual.style.display = 'block';
  
  // UI Update
  const width = Math.min(Math.max(ratio * 100, 0), 100);
  fill.style.width = `${width}%`;

  if (ratio <= 0.7) {
    verd.textContent = '🌿 Álcool Venceu!';
    verd.style.color = '#10b981';
    fill.style.background = 'linear-gradient(90deg, #059669, #10b981)';
    if (card) {
      card.style.boxShadow = '0 10px 40px rgba(16, 185, 129, 0.15)';
      card.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    }
    reas.textContent = `Economia real detectada! O álcool custa apenas ${(ratio * 100).toFixed(1)}% da gasolina.`;
  } else {
    verd.textContent = '⛽ Gasolina Venceu!';
    verd.style.color = '#0a84ff';
    fill.style.background = 'linear-gradient(90deg, #0040dd, #0a84ff)';
    if (card) {
      card.style.boxShadow = '0 10px 40px rgba(10, 132, 255, 0.15)';
      card.style.borderColor = 'rgba(10, 132, 255, 0.3)';
    }
    reas.textContent = `A gasolina é a melhor escolha. O álcool está em ${(ratio * 100).toFixed(1)}% do preço.`;
  }
}

/* ==========================================
   INITIALIZATION
   ========================================== */

document.addEventListener('DOMContentLoaded', () => {
  loadState();

  // If no vehicles, prompt to add
  if (!state.vehicles.length) {
    setTimeout(() => {
      toast('Bem-vindo ao KM Track! Adicione seu veículo para começar.', 'info');
    }, 300);
  }

  // --- Nav links (Bottom Tab Bar)
  document.querySelectorAll('.tab-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page || item.id.replace('nav-', '');
      navigateTo(page);
    });
  });

  // --- Header Action Center Listeners
  const btnHeaderAdd = document.getElementById('headerAddFuel');
  if (btnHeaderAdd) {
    btnHeaderAdd.addEventListener('click', () => {
      // FAB logic
      document.getElementById('fabNewFuel').click();
    });
  }

  const btnVehicleHeader = document.getElementById('iosVehicleBtn');
  if (btnVehicleHeader) {
    btnVehicleHeader.addEventListener('click', () => navigateTo('vehicles'));
  }

  const btnSettingsHeader = document.getElementById('nav-settings-header');
  if (btnSettingsHeader) {
    btnSettingsHeader.addEventListener('click', () => navigateTo('settings'));
  }

  // --- Vehicle quick select: "Add vehicle" button
  document.getElementById('btnAddVehicleQuick').addEventListener('click', () => {
    navigateTo('vehicles');
    openVehicleModal();
  });

  // --- Vehicles page: Add button
  document.getElementById('btnAddVehicle').addEventListener('click', () => openVehicleModal());

  // --- Vehicle form
  document.getElementById('vehicleForm').addEventListener('submit', saveVehicle);
  document.getElementById('closeVehicleModal').addEventListener('click', closeVehicleModal);
  document.getElementById('cancelVehicleModal').addEventListener('click', closeVehicleModal);
  document.getElementById('vehicleModalBackdrop').addEventListener('click', (e) => {
    if (e.target === document.getElementById('vehicleModalBackdrop')) closeVehicleModal();
  });

  // Icon picker
  document.querySelectorAll('.icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.icon-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('vehicleIcon').value = btn.dataset.icon;
    });
  });

  // --- Confirm modal
  document.getElementById('closeConfirmModal').addEventListener('click', closeConfirm);
  document.getElementById('cancelConfirm').addEventListener('click', closeConfirm);
  document.getElementById('confirmModalBackdrop').addEventListener('click', (e) => {
    if (e.target === document.getElementById('confirmModalBackdrop')) closeConfirm();
  });
  document.getElementById('okConfirm').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeConfirm();
  });

  // --- Fuel form
  document.getElementById('fuelForm').addEventListener('submit', saveFuel);
  document.getElementById('btnClearFuel').addEventListener('click', () => {
    document.getElementById('fuelForm').reset();
    setupFuelFormDefaults();
    document.getElementById('calcPreview').style.display = 'none';
  });

  // Fuel type grid
  document.getElementById('fuelTypeGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.fuel-btn');
    if (!btn) return;
    document.querySelectorAll('.fuel-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('selectedFuelType').value = btn.dataset.type;
  });

  // Fuel input mode
  document.querySelectorAll('input[name="fuelInputMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const mode = e.target.value;
      const litersMode = document.getElementById('litersMode');
      const totalMode = document.getElementById('totalMode');
      const litersInput = document.getElementById('fuelLiters');
      const totalInput = document.getElementById('fuelTotalCost');
      const pplInput = document.getElementById('fuelPricePerLiter');
      const pplTotalInput = document.getElementById('fuelPricePerLiterTotal');

      if (mode === 'liters') {
        litersMode.style.display = 'flex';
        totalMode.style.display = 'none';
        litersInput.required = true;
        totalInput.required = false;
        pplInput.required = true;
        pplTotalInput.required = false;
      } else {
        litersMode.style.display = 'none';
        totalMode.style.display = 'flex';
        litersInput.required = false;
        totalInput.required = true;
        pplInput.required = false;
        pplTotalInput.required = true;
      }
    });
  });

  // Auto calc
  document.getElementById('fuelLiters').addEventListener('input', recalcFuelCost);
  document.getElementById('fuelPricePerLiter').addEventListener('input', recalcFuelCost);
  document.getElementById('fuelTotalCost').addEventListener('input', recalcFuelCost);
  document.getElementById('fuelPricePerLiterTotal').addEventListener('input', recalcFuelCost);
  document.getElementById('fuelKmTotal').addEventListener('input', recalcFuelCost);

  // --- KM form
  document.getElementById('kmForm').addEventListener('submit', saveKm);
  document.getElementById('btnClearKm').addEventListener('click', () => {
    document.getElementById('kmForm').reset();
    setupKmFormDefaults();
    document.getElementById('kmPreview').style.display = 'none';
  });
  document.getElementById('kmStart').addEventListener('input', recalcKmDiff);
  document.getElementById('kmEnd').addEventListener('input', recalcKmDiff);

  // --- History tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      histTab = btn.dataset.tab;
      document.getElementById(histTab).classList.add('active');

      // Show/hide fuel type filter
      document.getElementById('filterFuelType').style.display = histTab === 'fuel-history' ? '' : 'none';
    });
  });

  // History filters
  document.getElementById('filterMonth').addEventListener('change', (e) => {
    histFilterMonth = e.target.value;
    renderHistory();
  });
  const filterFuelType = document.getElementById('filterFuelType');
  if (filterFuelType) filterFuelType.addEventListener('change', (e) => {
    histFilterFuelType = e.target.value;
    renderHistory();
  });
  const btnClearFilters = document.getElementById('btnClearFilters');
  if (btnClearFilters) btnClearFilters.addEventListener('click', () => {
    histFilterMonth = '';
    histFilterFuelType = '';
    document.getElementById('filterMonth').value = '';
    document.getElementById('filterFuelType').value = '';
    renderHistory();
  });

  // --- Settings & Auth Events
  const btnExpS = document.getElementById('btnSettingsExport');
  if (btnExpS) btnExpS.addEventListener('click', exportData);
  
  const btnClrS = document.getElementById('btnSettingsClear');
  if (btnClrS) btnClrS.addEventListener('click', clearAllData);
  
  const btnLogoutS = document.getElementById('btnSettingsLogout');
  if (btnLogoutS) btnLogoutS.addEventListener('click', logout);

  const importFile = document.getElementById('importFile');
  if (importFile) importFile.addEventListener('change', importData);

  const btnLoginMain = document.getElementById('btnGoogleLoginMain');
  if (btnLoginMain) btnLoginMain.addEventListener('click', loginWithGoogle);

  // --- Cancel edit fuel
  document.getElementById('btnCancelEditFuel').addEventListener('click', () => {
    document.getElementById('fuelForm').reset();
    document.getElementById('fuelEditId').value = '';
    setupFuelFormDefaults();
    document.getElementById('calcPreview').style.display = 'none';
    updateFuelFormMode(false);
  });

  // --- Cancel edit KM
  document.getElementById('btnCancelEditKm').addEventListener('click', () => {
    document.getElementById('kmForm').reset();
    document.getElementById('kmEditId').value = '';
    setupKmFormDefaults();
    document.getElementById('kmPreview').style.display = 'none';
    updateKmFormMode(false);
  });

  // --- Floating Action Button
  document.getElementById('fabNewFuel').addEventListener('click', () => {
    // Cancel any editing
    document.getElementById('fuelForm').reset();
    document.getElementById('fuelEditId').value = '';
    setupFuelFormDefaults();
    document.getElementById('calcPreview').style.display = 'none';
    updateFuelFormMode(false);
    navigateTo('register');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Finalize
  // Initial PWA check
  initPWA();

  // --- Initial render
  setupFuelFormDefaults();
  setupKmFormDefaults();
  updateVehicleUI();
  renderDashboard();


  // Note: Automatic vehicle modal prompt moved to post-login sync logic


  // --- Intelligence Phase Listeners
  const btnExcel = document.getElementById('btnExportExcel');
  if (btnExcel) btnExcel.addEventListener('click', exportToExcel);

  const btnHeaderFlex = document.getElementById('headerFlexBtn');
  if (btnHeaderFlex) btnHeaderFlex.addEventListener('click', openFlex);

  const btnHeaderVehicle = document.getElementById('iosVehicleIcon');
  if (btnHeaderVehicle) btnHeaderVehicle.addEventListener('click', cycleVehicle);

  const btnCloseFlex = document.getElementById('closeFlexModal');
  if (btnCloseFlex) btnCloseFlex.addEventListener('click', () => {
    document.getElementById('flexModalBackdrop').classList.remove('open');
  });

  const flexPriceGas = document.getElementById('flexPriceGas');
  const flexPriceAlc = document.getElementById('flexPriceAlc');
  if(flexPriceGas) flexPriceGas.addEventListener('input', calculateFlex);
  if(flexPriceAlc) flexPriceAlc.addEventListener('input', calculateFlex);

  // --- Trash Modal Buttons

  const btnCloseTrash = document.getElementById('closeTrashModal');
  if (btnCloseTrash) btnCloseTrash.addEventListener('click', () => {
    document.getElementById('trashModalBackdrop').classList.remove('open');
  });

  const btnClearTrash = document.getElementById('btnClearTrash');
  if (btnClearTrash) btnClearTrash.addEventListener('click', () => {
    if (!state.trash.length) return;
    openConfirm('Esvaziar Lixeira', 'Deseja apagar TODOS os itens da lixeira permanentemente?', () => {
      state.trash = [];
      saveState();
      renderTrash();
      syncToCloud();
      toast('Lixeira esvaziada! 🗑️', 'success');
    });
  });

  // Final UI Auto-open adjustments
  if (state.vehicles.length === 0 && currentUser) {
    setTimeout(() => openVehicleModal(), 1000);
  }

  // --- Profile Pic Viewer Logic
  const avatar = document.getElementById('headerProfilePic');
  const viewer = document.getElementById('imageViewerModal');
  const fullImg = document.getElementById('fullSizeProfilePic');
  const closeViewer = document.getElementById('closeImageViewer');

  if (avatar) {
    avatar.addEventListener('click', () => {
      if (currentUser && currentUser.photoURL) {
        fullImg.src = currentUser.photoURL;
        viewer.classList.add('open');
      }
    });
  }

  if (closeViewer) {
    closeViewer.addEventListener('click', () => {
      viewer.classList.remove('open');
    });
  }

  if (viewer) {
    viewer.addEventListener('click', (e) => {
      if (e.target === viewer) viewer.classList.remove('open');
    });
  }
});

// --- Flex Logic 2.0 (Global Scope)
function openFlex() {
  const backdrop = document.getElementById('flexModalBackdrop');
  if (!backdrop) return;
  backdrop.classList.add('open');
  document.getElementById('flexVisualArea').style.display = 'none';
  document.getElementById('flexPriceGas').value = '';
  document.getElementById('flexPriceAlc').value = '';
}

// --- Trash Logic (Global Scope)
function renderTrash() {
  console.log('Executando renderTrash...');
  const list = document.getElementById('trashList');
  if (!list) {
    console.error('Lixeira: lista (trashList) não encontrada!');
    return;
  }
  
  if (!state.trash || state.trash.length === 0) {
    list.innerHTML = '<div class="empty-state"><span>🗑️</span><p>Lixeira vazia.</p></div>';
    return;
  }

  list.innerHTML = state.trash.sort((a,b) => b.deletedAt.localeCompare(a.deletedAt)).map(item => {
    let title = "Item Desconhecido";
    let icon = "❓";
    if (item.type === 'vehicle') { title = item.data.name; icon = "🚗"; }
    if (item.type === 'fuel') { title = `Abast. ${fmt(item.data.totalCost)}`; icon = "⛽"; }
    if (item.type === 'km') { title = `KM +${item.data.kmDiff}`; icon = "📍"; }

    return `
      <div class="trash-item">
        <div class="trash-item-info">
          <div class="trash-item-icon">${icon}</div>
          <div class="trash-item-text">
            <span class="trash-item-title">${title}</span>
            <span class="trash-item-meta">Apagado em: ${formatDate(item.deletedAt.split('T')[0])}</span>
          </div>
        </div>
        <div class="trash-item-actions">
          <button class="btn btn-ghost btn-sm" onclick="restoreFromTrash('${item.trashId}')" title="Restaurar">🔄</button>
          <button class="btn btn-ghost btn-danger btn-sm" onclick="permanentDelete('${item.trashId}')" title="Excluir Definitivamente">🛑</button>
        </div>
      </div>
    `;
  }).join('');
}

function restoreFromTrash(trashId) {
  const idx = state.trash.findIndex(i => i.trashId === trashId);
  if (idx === -1) return;
  const item = state.trash[idx];

  if (item.type === 'vehicle') {
    state.vehicles.push(item.data);
    if (item.relatedData) {
      if (item.relatedData.fuel) state.fuelLogs.push(...item.relatedData.fuel);
      if (item.relatedData.km) state.kmLogs.push(...item.relatedData.km);
    }
    renderVehicles();
  } else if (item.type === 'fuel') {
    state.fuelLogs.push(item.data);
  } else if (item.type === 'km') {
    state.kmLogs.push(item.data);
  }

  state.trash.splice(idx, 1);
  saveState();
  renderTrash();
  renderDashboard();
  renderHistory();
  syncToCloud();
  toast('Item restaurado com sucesso! 🔄', 'success');
}

function permanentDelete(trashId) {
  openConfirm('Excluir Definitivamente', 'Esta ação eliminará os dados para sempre. Continuar?', async () => {
    const idx = state.trash.findIndex(i => i.trashId === trashId);
    if (idx !== -1 && currentUser) {
      try { await deleteDoc(doc(db, "users", currentUser.uid, "trash", trashId)); } catch(e){}
    }
    state.trash = state.trash.filter(i => i.trashId !== trashId);
    saveState();
    renderTrash();
    syncToCloud();
    toast('Item excluído permanentemente.', 'error');
  });
}

window.openTrash = function() {
  console.log('Executando window.openTrash...');
  const backdrop = document.getElementById('trashModalBackdrop');
  if (backdrop) {
    backdrop.classList.add('open');
    renderTrash();
  } else {
    console.error('Lixeira: backdrop não encontrado!');
  }
};

function cycleVehicle() {
  if (state.vehicles.length < 2) return;
  const currentIdx = state.vehicles.findIndex(v => v.id === state.activeVehicleId);
  const nextIdx = (currentIdx + 1) % state.vehicles.length;
  const nextVeh = state.vehicles[nextIdx];
  if (nextVeh) {
    setActiveVehicle(nextVeh.id);
    toast(`Veículo alterado: ${nextVeh.name}`, 'success');
  }
}

Object.assign(window, {
  state,
  setActiveVehicle,
  openVehicleModal,
  deleteVehicle,
  editFuelLog,
  deleteFuelLog,
  editKmLog,
  deleteKmLog,
  restoreFromTrash,
  permanentDelete,
  calculateFlex,
  openFlex,
  openTrash,
  cycleVehicle
});
