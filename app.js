/* ==========================================
   KM TRACK — APPLICATION LOGIC
   ========================================== */

'use strict';

/* ==========================================
   PWA — SERVICE WORKER REGISTRATION
   ========================================== */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('[PWA] Service Worker registrado:', reg.scope))
      .catch(err => console.warn('[PWA] Falha ao registrar SW:', err));
  });
}

// PWA install prompt
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner();
});

window.addEventListener('appinstalled', () => {
  hideInstallBanner();
  deferredInstallPrompt = null;
  toast('KM Track instalado com sucesso! 🎉', 'success');
});

function showInstallBanner() {
  const banner = document.getElementById('installBanner');
  if (banner) {
    banner.classList.add('visible');
  }
}

function hideInstallBanner() {
  const banner = document.getElementById('installBanner');
  if (banner) {
    banner.classList.remove('visible');
  }
}

async function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    hideInstallBanner();
  }
  deferredInstallPrompt = null;
}

/* ==========================================
   STATE & STORAGE
   ========================================== */

const STORAGE_KEY = 'kmtrack_data';

const defaultState = () => ({
  vehicles: [],
  activeVehicleId: null,
  fuelLogs: [],      // { id, vehicleId, date, kmTotal, fuelType, liters, pricePerLiter, totalCost, station, notes }
  kmLogs: [],        // { id, vehicleId, date, kmStart, kmEnd, kmDiff, purpose, notes }
});

let state = defaultState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) { console.warn('Failed to load state', e); }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Failed to save state', e); }
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

function getMonthStr(date) {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function currentMonthKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

function fuelLabel(type) {
  const map = { gasolina: 'Gasolina', alcool: 'Álcool', diesel: 'Diesel', gnv: 'GNV' };
  return map[type] || type;
}

function fuelEmoji(type) {
  const map = { gasolina: '⛽', alcool: '🌿', diesel: '🛢️', gnv: '💨' };
  return map[type] || '⛽';
}

function purposeLabel(p) {
  const map = { pessoal: '🏠 Pessoal', trabalho: '💼 Trabalho', viagem: '✈️ Viagem', outros: '📦 Outros' };
  return map[p] || p;
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
  if (page === 'settings') renderSettings();
  if (page === 'km') renderKmToday();
}


/* ==========================================
   TOAST
   ========================================== */

function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3000);
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

function openVehicleModal(vehicle = null) {
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
    document.getElementById('vehicleIcon').value = vehicle.icon || '🚗';
    // Update icon picker
    document.querySelectorAll('.icon-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.icon === vehicle.icon);
    });
  } else {
    document.getElementById('vehicleModalTitle').textContent = 'Adicionar Veículo';
    document.getElementById('vehicleId').value = '';
    document.getElementById('vehicleIcon').value = '🚗';
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
  openConfirm('Remover veículo', 'Deseja remover este veículo? Os registros vinculados serão mantidos.', () => {
    state.vehicles = state.vehicles.filter(v => v.id !== id);
    if (state.activeVehicleId === id) {
      state.activeVehicleId = state.vehicles[0]?.id || null;
    }
    saveState();
    renderVehicles();
    updateVehicleUI();
    renderDashboard();
    toast('Veículo removido.', 'success');
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
        <button class="btn btn-sm btn-secondary" onclick="openVehicleModal(state.vehicles.find(v=>v.id==='${v.id}'))">✏️</button>
        <button class="btn btn-sm btn-ghost" onclick="deleteVehicle('${v.id}')">🗑️</button>
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

  const liters = parseFloat(document.getElementById('fuelLiters').value) || 0;
  const ppl = parseFloat(document.getElementById('fuelPricePerLiter').value) || 0;
  let total = parseFloat(document.getElementById('fuelTotalCost').value) || 0;
  if (!total && liters && ppl) total = liters * ppl;

  const date = document.getElementById('fuelDate').value;
  const kmTotal = parseFloat(document.getElementById('fuelKmTotal').value) || 0;

  if (!date) { toast('Informe a data.', 'error'); return; }
  if (!kmTotal) { toast('Informe o KM do odômetro.', 'error'); return; }
  if (!liters && !total) { toast('Informe os litros ou o valor total.', 'error'); return; }

  const editingId = document.getElementById('fuelEditId').value;

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
    createdAt: editingId ? (state.fuelLogs.find(l => l.id === editingId)?.createdAt || Date.now()) : Date.now(),
  };

  if (editingId) {
    const idx = state.fuelLogs.findIndex(l => l.id === editingId);
    if (idx !== -1) state.fuelLogs[idx] = log;
  } else {
    state.fuelLogs.unshift(log);
  }

  // Update vehicle initial km if larger
  const v = state.vehicles.find(v => v.id === state.activeVehicleId);
  if (v && kmTotal > (v.kmInitial || 0)) { v.kmInitial = kmTotal; }

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

function deleteFuelLog(id) {
  openConfirm('Remover registro', 'Deseja remover este abastecimento?', () => {
    state.fuelLogs = state.fuelLogs.filter(l => l.id !== id);
    saveState();
    renderHistory();
    renderDashboard();
    toast('Registro removido.', 'success');
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
  const kmStart = parseFloat(document.getElementById('kmStart').value) || 0;
  const kmEnd = parseFloat(document.getElementById('kmEnd').value) || 0;

  if (!date) { toast('Informe a data.', 'error'); return; }
  if (!kmStart && !kmEnd) { toast('Informe pelo menos o KM inicial ou final.', 'error'); return; }
  if (kmEnd && kmStart && kmEnd < kmStart) { toast('KM final não pode ser menor que KM inicial.', 'error'); return; }

  const editingId = document.getElementById('kmEditId').value;

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

function deleteKmLog(id) {
  openConfirm('Remover registro', 'Deseja remover este registro de KM?', () => {
    state.kmLogs = state.kmLogs.filter(l => l.id !== id);
    saveState();
    renderHistory();
    renderKmToday();
    renderDashboard();
    toast('Registro removido.', 'success');
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

  const vFuel = vId ? state.fuelLogs.filter(l => l.vehicleId === vId) : [];
  const vKm = vId ? state.kmLogs.filter(l => l.vehicleId === vId) : [];

  // Stats
  const kmTotal = v ? (v.kmInitial || 0) : 0;
  const gastoTotal = vFuel.reduce((s, l) => s + (l.totalCost || 0), 0);
  const litrosTotal = vFuel.reduce((s, l) => s + (l.liters || 0), 0);

  // Media consumo: KM diff entre primeiro e ultimo abastecimento / litros
  let mediaConsumo = '—';
  if (vFuel.length >= 2) {
    const sorted = [...vFuel].sort((a, b) => a.date.localeCompare(b.date));
    const kmDiff = sorted[sorted.length - 1].kmTotal - sorted[0].kmTotal;
    const litrosUsados = sorted.slice(1).reduce((s, l) => s + (l.liters || 0), 0);
    if (litrosUsados > 0) mediaConsumo = fmtNum(kmDiff / litrosUsados, 1) + ' km/L';
  }

  document.getElementById('statKmTotal').textContent = fmtNum(kmTotal) + ' km';
  document.getElementById('statGastoTotal').textContent = fmt(gastoTotal);
  document.getElementById('statLitrosTotal').textContent = fmtNum(litrosTotal, 1) + ' L';
  document.getElementById('statMediaConsumo').textContent = mediaConsumo;

  // Last fill
  const lastFill = vFuel[0];
  const lastFillCard = document.getElementById('lastFillCard');
  if (lastFill) {
    lastFillCard.innerHTML = `<div class="last-fill-info">
      <div class="lf-row"><span class="lf-label">Data</span><span class="lf-value">${formatDate(lastFill.date)}</span></div>
      <div class="lf-row"><span class="lf-label">Combustível</span><span class="fuel-badge ${lastFill.fuelType}">${fuelEmoji(lastFill.fuelType)} ${fuelLabel(lastFill.fuelType)}</span></div>
      <div class="lf-row"><span class="lf-label">Litros</span><span class="lf-value">${fmtNum(lastFill.liters, 2)} L</span></div>
      <div class="lf-row"><span class="lf-label">Valor total</span><span class="lf-value">${fmt(lastFill.totalCost)}</span></div>
      <div class="lf-row"><span class="lf-label">Preço/L</span><span class="lf-value">${fmt(lastFill.pricePerLiter)}</span></div>
      ${lastFill.station ? `<div class="lf-row"><span class="lf-label">Posto</span><span class="lf-value">${escHtml(lastFill.station)}</span></div>` : ''}
      <div class="lf-row"><span class="lf-label">Odômetro</span><span class="lf-value">${fmtNum(lastFill.kmTotal)} km</span></div>
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
      <div class="lf-row"><span class="lf-label">KM rodados hoje</span><span class="lf-value" style="color:var(--success);font-size:1.1rem;">${fmtNum(totalToday)} km</span></div>
      ${kmToday.map(l => `<div class="lf-row"><span class="lf-label">${purposeLabel(l.purpose)}</span><span class="lf-value">${fmtNum(l.kmDiff)} km</span></div>`).join('')}
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
  document.getElementById('msKm').textContent = fmtNum(monthKm.reduce((s, l) => s + (l.kmDiff || 0), 0)) + ' km';

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
          <span>${purposeLabel(l.purpose)}</span>
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
  let logs = state.fuelLogs.filter(l => l.vehicleId === vId);
  if (histFilterMonth) logs = logs.filter(l => l.date?.startsWith(histFilterMonth));
  if (histFilterFuelType) logs = logs.filter(l => l.fuelType === histFilterFuelType);

  const container = document.getElementById('fuelHistoryList');
  if (!logs.length) {
    container.innerHTML = '<div class="empty-state"><span>⛽</span><p>Nenhum registro encontrado.</p></div>';
    return;
  }

  container.innerHTML = logs.map(l => `
    <div class="hist-item ${l.fuelType}">
      <div class="hist-item-header">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <span class="fuel-badge ${l.fuelType}">${fuelEmoji(l.fuelType)} ${fuelLabel(l.fuelType)}</span>
          <span class="hist-item-date">${formatDate(l.date)}</span>
        </div>
        <span class="hist-item-cost">${fmt(l.totalCost)}</span>
      </div>
      <div class="hist-item-details">
        <span class="hist-detail">🛢️ <span>${fmtNum(l.liters, 2)} L</span></span>
        <span class="hist-detail">💲 <span>${fmt(l.pricePerLiter)}/L</span></span>
        <span class="hist-detail">📏 <span>${fmtNum(l.kmTotal)} km</span></span>
        ${l.station ? `<span class="hist-detail">📍 <span>${escHtml(l.station)}</span></span>` : ''}
        ${l.notes ? `<span class="hist-detail">📝 <span>${escHtml(l.notes)}</span></span>` : ''}
      </div>
      <div class="hist-item-actions">
        <button class="hist-action-btn edit" onclick="editFuelLog('${l.id}')" title="Editar">✏️</button>
        <button class="hist-action-btn" onclick="deleteFuelLog('${l.id}')" title="Remover">🗑️</button>
      </div>
    </div>
  `).join('');
}

function renderKmHistory(vId) {
  let logs = state.kmLogs.filter(l => l.vehicleId === vId);
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
          <span class="hist-item-date">${formatDate(l.date)}</span>
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
    totalSpent: state.fuelLogs.reduce((s, l) => s + (l.totalCost || 0), 0),
    totalLiters: state.fuelLogs.reduce((s, l) => s + (l.liters || 0), 0),
  };

  document.getElementById('settingsStats').innerHTML = `
    <div class="settings-stat"><div class="settings-stat-val">${total.vehicles}</div><div class="settings-stat-lbl">Veículos</div></div>
    <div class="settings-stat"><div class="settings-stat-val">${total.fuelLogs}</div><div class="settings-stat-lbl">Abastecimentos</div></div>
    <div class="settings-stat"><div class="settings-stat-val">${total.kmLogs}</div><div class="settings-stat-lbl">Registros de KM</div></div>
    <div class="settings-stat"><div class="settings-stat-val">${fmt(total.totalSpent)}</div><div class="settings-stat-lbl">Total gasto</div></div>
    <div class="settings-stat"><div class="settings-stat-val">${fmtNum(total.totalLiters, 1)} L</div><div class="settings-stat-lbl">Litros abastecidos</div></div>
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

  // Navigate to register page
  navigateTo('register');

  // Fill form with log data
  document.getElementById('fuelEditId').value = log.id;
  document.getElementById('fuelDate').value = log.date;
  document.getElementById('fuelKmTotal').value = log.kmTotal || '';
  document.getElementById('fuelLiters').value = log.liters || '';
  document.getElementById('fuelPricePerLiter').value = log.pricePerLiter || '';
  document.getElementById('fuelTotalCost').value = log.totalCost || '';
  document.getElementById('fuelStation').value = log.station || '';
  document.getElementById('fuelNotes').value = log.notes || '';

  // Set fuel type
  document.getElementById('selectedFuelType').value = log.fuelType || 'gasolina';
  document.querySelectorAll('.fuel-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === log.fuelType);
  });

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
  document.querySelectorAll('.fuel-btn').forEach((b, i) => b.classList.toggle('active', i === 0));

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
  const liters = parseFloat(document.getElementById('fuelLiters').value) || 0;
  const ppl = parseFloat(document.getElementById('fuelPricePerLiter').value) || 0;

  if (liters > 0 && ppl > 0) {
    const total = liters * ppl;
    document.getElementById('fuelTotalCost').value = total.toFixed(2);
  }

  // Calc cost per km estimate
  const km = parseFloat(document.getElementById('fuelKmTotal').value) || 0;
  const v = getActiveVehicle();
  const prevKm = v ? (v.kmInitial || 0) : 0;
  const totalCost = parseFloat(document.getElementById('fuelTotalCost').value) || 0;

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
      navigateTo(item.dataset.page);
    });
  });

  // --- iOS Header Vehicle Button
  const vehicleBtn = document.getElementById('iosVehicleBtn');
  if (vehicleBtn) {
    vehicleBtn.addEventListener('click', () => {
      navigateTo('vehicles');
    });
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

  // Auto calc
  document.getElementById('fuelLiters').addEventListener('input', recalcFuelCost);
  document.getElementById('fuelPricePerLiter').addEventListener('input', recalcFuelCost);
  document.getElementById('fuelTotalCost').addEventListener('input', () => {
    // If user fills total manually, backfill pricePerLiter
    const total = parseFloat(document.getElementById('fuelTotalCost').value) || 0;
    const liters = parseFloat(document.getElementById('fuelLiters').value) || 0;
    if (total > 0 && liters > 0) {
      document.getElementById('fuelPricePerLiter').value = (total / liters).toFixed(3);
    }
    recalcFuelCost();
  });
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
  document.getElementById('filterFuelType').addEventListener('change', (e) => {
    histFilterFuelType = e.target.value;
    renderHistory();
  });
  document.getElementById('btnClearFilters').addEventListener('click', () => {
    histFilterMonth = '';
    histFilterFuelType = '';
    document.getElementById('filterMonth').value = '';
    document.getElementById('filterFuelType').value = '';
    renderHistory();
  });

  // --- Settings
  document.getElementById('btnExport').addEventListener('click', exportData);
  document.getElementById('importFile').addEventListener('change', importData);
  document.getElementById('btnClearAllData').addEventListener('click', clearAllData);

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

  // --- Initial render
  setupFuelFormDefaults();
  setupKmFormDefaults();
  updateVehicleUI();
  renderDashboard();

  // If no vehicle, open vehicle modal after a brief delay
  if (!state.vehicles.length) {
    setTimeout(() => openVehicleModal(), 600);
  }

  // PWA: install banner dismiss button
  const btnDismissInstall = document.getElementById('btnDismissInstall');
  if (btnDismissInstall) {
    btnDismissInstall.addEventListener('click', hideInstallBanner);
  }
  const btnInstallApp = document.getElementById('btnInstallApp');
  if (btnInstallApp) {
    btnInstallApp.addEventListener('click', triggerInstall);
  }
});
