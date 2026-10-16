(() => {
  const STORAGE_KEY = 'edgebook.journal.v1';
  const STORAGE_BUCKET = 'trade-screenshots';
  const config = window.EDGEBOOK_CONFIG || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const today = new Date();
  const localDate = (date) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const newId = () => globalThis.crypto?.randomUUID?.() || `trade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let supabase = null;
  if (window.supabase?.createClient && /^https:\/\//.test(config.supabaseUrl || '') && (config.supabaseAnonKey || '').length > 20 && !String(config.supabaseUrl).includes('YOUR-PROJECT')) {
    supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  }
  let trades = [];
  let activeUser = null;
  let activeUserId = null;
  let cloudDataLoaded = false;
  let authMode = 'signin';
  let legacyTrades = [];
  let authListenerStarted = false;
  let currentPeriod = '30';
  let editingId = null;
  let toastTimer;
  let imageDbPromise = null;
  let modalScreenshots = [];
  let originalScreenshotIds = new Set();
  let originalScreenshotMeta = new Map();
  let galleryUrls = [];
  let modalToken = 0;
  let screenshotProcessing = Promise.resolve();
  let screenshotTasks = 0;
  let screenshotLoadPending = false;
  let tradeSavePending = false;

  function readLegacyTrades() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(normalizeTrade).filter(Boolean) : [];
    } catch (error) { return []; }
  }

  function normalizeTrade(trade) {
    if (!trade || typeof trade !== 'object' || !trade.symbol) return null;
    return {
      id: String(trade.id || newId()), symbol: String(trade.symbol), side: trade.side === 'Short' ? 'Short' : 'Long',
      setup: String(trade.setup || ''), date: /^\d{4}-\d{2}-\d{2}$/.test(trade.date || '') ? trade.date : localDate(new Date()),
      entry: finiteOrNull(trade.entry), exit: finiteOrNull(trade.exit), size: finiteOrNull(trade.size),
      pnl: finiteOrNull(trade.pnl) ?? 0, risk: finiteOrNull(trade.risk), status: trade.status === 'open' ? 'open' : 'closed',
      plan: ['yes', 'no', 'na'].includes(trade.plan) ? trade.plan : 'na', emotion: String(trade.emotion || ''), notes: String(trade.notes || ''), sample: trade.sample === true
    };
  }

  function fromCloudTrade(row) {
    return normalizeTrade({
      id: row.id, symbol: row.symbol, side: row.side, setup: row.setup, date: row.trade_date,
      entry: row.entry_price, exit: row.exit_price, size: row.size, pnl: row.pnl_usd, risk: row.risk_usd,
      status: row.status, plan: row.plan, emotion: row.emotion, notes: row.notes, sample: row.is_sample
    });
  }

  function toCloudTrade(trade, userId = activeUserId) {
    return {
      id: trade.id, user_id: userId, symbol: trade.symbol, side: trade.side, setup: trade.setup,
      trade_date: trade.date, entry_price: trade.entry, exit_price: trade.exit, size: trade.size,
      pnl_usd: trade.pnl, risk_usd: trade.risk, status: trade.status, plan: trade.plan,
      emotion: trade.emotion, notes: trade.notes, is_sample: trade.sample === true, updated_at: new Date().toISOString()
    };
  }

  function finiteOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function openImageDatabase() {
    if (imageDbPromise) return imageDbPromise;
    imageDbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('This browser does not support local screenshot storage.')); return; }
      const request = indexedDB.open('edgebook.images.v1', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('screenshots')) {
          const store = db.createObjectStore('screenshots', { keyPath: 'id' });
          store.createIndex('tradeId', 'tradeId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local screenshot storage.'));
      request.onblocked = () => reject(new Error('Screenshot storage is busy in another tab. Close other Edgebook tabs and try again.'));
    });
    return imageDbPromise;
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save screenshots.'));
      transaction.onabort = () => reject(transaction.error || new Error('Screenshot save was cancelled.'));
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not read screenshots.'));
    });
  }

  async function getAllLegacyScreenshotRecords() {
    const db = await openImageDatabase();
    const transaction = db.transaction('screenshots', 'readonly');
    return requestResult(transaction.objectStore('screenshots').getAll());
  }

  async function getCloudScreenshotsForTrade(tradeId) {
    const { data, error } = await supabase.from('trade_screenshots').select('id,trade_id,user_id,storage_path,file_name,created_at').eq('trade_id', tradeId).order('created_at');
    if (error) throw error;
    return Promise.all((data || []).map(async (image) => {
      const { data: signed, error: signedError } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(image.storage_path, 3600);
      if (signedError) throw signedError;
      return { ...image, name: image.file_name, signedUrl: signed.signedUrl, isNew: false };
    }));
  }

  async function storeCloudScreenshot(tradeId, image, userId = activeUserId) {
    const path = `${userId}/${tradeId}/${image.id}.jpg`;
    const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(path, image.blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
    if (uploadError) throw uploadError;
    const { error: rowError } = await supabase.from('trade_screenshots').insert({ id: image.id, trade_id: tradeId, user_id: userId, storage_path: path, file_name: image.name });
    if (rowError) {
      await supabase.storage.from(STORAGE_BUCKET).remove([path]);
      throw rowError;
    }
    return { id: image.id, storage_path: path, trade_id: tradeId, user_id: userId, file_name: image.name };
  }

  async function uploadCloudScreenshot(tradeId, image) {
    const stored = await storeCloudScreenshot(tradeId, image);
    image.storage_path = stored.storage_path;
    image.signedUrl = null;
    image.isNew = false;
    originalScreenshotIds.add(image.id);
    originalScreenshotMeta.set(image.id, stored);
  }

  async function syncCloudScreenshots(tradeId) {
    const retainedIds = new Set(modalScreenshots.map((image) => image.id));
    const removedIds = [...originalScreenshotIds].filter((id) => !retainedIds.has(id));
    const added = modalScreenshots.filter((image) => !originalScreenshotIds.has(image.id));
    for (const id of removedIds) {
      const meta = originalScreenshotMeta.get(id);
      if (meta?.storage_path) {
        const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove([meta.storage_path]);
        if (storageError) throw storageError;
      }
      const { error } = await supabase.from('trade_screenshots').delete().eq('id', id).eq('user_id', activeUserId);
      if (error) throw error;
      originalScreenshotIds.delete(id);
      originalScreenshotMeta.delete(id);
    }
    for (const image of added) await uploadCloudScreenshot(tradeId, image);
  }

  async function deleteCloudScreenshotsForTrade(tradeId) {
    const { data: images, error } = await supabase.from('trade_screenshots').select('id,storage_path').eq('trade_id', tradeId).eq('user_id', activeUserId);
    if (error) throw error;
    if (!images.length) return;
    const paths = images.map((image) => image.storage_path);
    const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
    if (storageError) throw storageError;
    const { error: deleteError } = await supabase.from('trade_screenshots').delete().in('id', images.map((image) => image.id)).eq('user_id', activeUserId);
    if (deleteError) throw deleteError;
  }

  async function deleteCloudScreenshotsForTrades(tradeIds) {
    for (const tradeId of tradeIds) await deleteCloudScreenshotsForTrade(tradeId);
  }

  function releaseGalleryUrls() {
    galleryUrls.forEach((url) => URL.revokeObjectURL(url));
    galleryUrls = [];
  }

  function renderScreenshotGallery() {
    releaseGalleryUrls();
    const gallery = $('#screenshotGallery');
    gallery.innerHTML = modalScreenshots.map((image) => {
      const url = image.blob ? URL.createObjectURL(image.blob) : image.signedUrl;
      if (image.blob) galleryUrls.push(url);
      return `<div class="screenshot-card"><button type="button" class="screenshot-remove" data-remove-screenshot="${escapeHtml(image.id)}" aria-label="Remove ${escapeHtml(image.name)}">×</button><img src="${url}" alt="${escapeHtml(image.name)}"><span title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</span></div>`;
    }).join('');
  }

  function updateSaveButton() {
    $('#saveTradeButton').disabled = screenshotLoadPending || screenshotTasks > 0 || tradeSavePending;
  }

  async function compressScreenshot(file) {
    if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`);
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error(`Could not process ${file.name}.`)), 'image/jpeg', 0.84));
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'screenshot';
    return { id: newId(), name: `${baseName}.jpg`, type: 'image/jpeg', blob, isNew: true };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not prepare backup image.'));
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [metadata, content] = String(dataUrl).split(',');
    const type = metadata.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    const binary = atob(content || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  function authFeedback(message, isError = false) {
    const box = $('#authMessage');
    box.textContent = message;
    box.classList.remove('hidden', 'error');
    if (isError) box.classList.add('error');
  }

  function setAuthMode(mode) {
    authMode = mode;
    const isSignup = mode === 'signup';
    $('#authSubmit').textContent = isSignup ? 'Create account' : 'Sign in';
    $('#authModeToggle').textContent = isSignup ? 'Sign in instead' : 'Create an account';
    $('#authSwitchPrompt').textContent = isSignup ? 'Already have an account?' : 'New to Edgebook?';
    $('#authPassword').autocomplete = isSignup ? 'new-password' : 'current-password';
    $('#authMessage').classList.add('hidden');
  }

  function showAuthScreen() {
    $('#appShell').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
  }

  function showAppScreen() {
    $('#authScreen').classList.add('hidden');
    $('#appShell').classList.remove('hidden');
  }

  function safeLocalGet(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }

  async function loadAccountTrades(userId) {
    const { data, error } = await supabase.from('trades').select('*').eq('user_id', userId).order('trade_date', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(fromCloudTrade).filter(Boolean);
  }

  async function saveAccountTrade(trade, isUpdate) {
    const payload = toCloudTrade(trade);
    const result = isUpdate
      ? await supabase.from('trades').update(payload).eq('id', trade.id).eq('user_id', activeUserId).select('*').single()
      : await supabase.from('trades').insert(payload).select('*').single();
    if (result.error) throw result.error;
    return fromCloudTrade(result.data);
  }

  function updateAccountBadge(user) {
    const email = user?.email || 'Signed in';
    const name = user?.user_metadata?.full_name || user?.user_metadata?.name || email.split('@')[0] || 'Trader';
    $('#accountName').textContent = name;
    $('#accountEmail').textContent = email;
    $('#accountAvatar').textContent = name.slice(0, 1).toUpperCase();
    $('#settingsAccountTitle').textContent = email;
    $('#settingsAccountDescription').textContent = 'Your trades and screenshots are private to this account.';
  }

  function updateLegacyMigrationBanner() {
    legacyTrades = readLegacyTrades();
    const dismissed = safeLocalGet(`${STORAGE_KEY}.migration-dismissed.${activeUserId}`) === 'true' || safeLocalGet(`${STORAGE_KEY}.migrated.${activeUserId}`) === 'true';
    const show = Boolean(cloudDataLoaded && trades.length === 0 && legacyTrades.length && !dismissed);
    $('#localMigrationBanner').classList.toggle('hidden', !show);
    $('#legacyTradeCount').textContent = `${legacyTrades.length} ${legacyTrades.length === 1 ? 'trade' : 'trades'}`;
  }

  async function handleSession(session) {
    if (!session?.user) {
      activeUser = null;
      activeUserId = null;
      cloudDataLoaded = false;
      trades = [];
      $('#localMigrationBanner').classList.add('hidden');
      showAuthScreen();
      return;
    }
    if (activeUserId === session.user.id && cloudDataLoaded) return;
    activeUser = session.user;
    activeUserId = session.user.id;
    cloudDataLoaded = false;
    const requestedUserId = activeUserId;
    updateAccountBadge(activeUser);
    showAppScreen();
    try {
      const accountTrades = await loadAccountTrades(requestedUserId);
      if (activeUserId !== requestedUserId) return;
      trades = accountTrades;
      cloudDataLoaded = true;
      renderAll();
      updateLegacyMigrationBanner();
    } catch (error) {
      if (activeUserId !== requestedUserId) return;
      trades = [];
      renderAll();
      notify(`Could not load your account journal: ${error.message}`);
    }
  }

  async function initializeAuth() {
    if (!supabase) {
      showAuthScreen();
      $('#authSubmit').disabled = true;
      const configured = /^https:\/\//.test(config.supabaseUrl || '') && (config.supabaseAnonKey || '').length > 20 && !String(config.supabaseUrl).includes('YOUR-PROJECT');
      authFeedback(configured ? 'The Supabase client did not load. Check your internet connection and refresh.' : 'Add your Supabase Project URL and publishable/anon key in config.js, then open Edgebook through localhost.', true);
      return;
    }
    if (!authListenerStarted) {
      authListenerStarted = true;
      supabase.auth.onAuthStateChange((_event, session) => setTimeout(() => { void handleSession(session); }, 0));
    }
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      showAuthScreen();
      authFeedback(error.message, true);
      return;
    }
    await handleSession(data.session);
  }

  async function importLegacyJournal() {
    if (!legacyTrades.length || !activeUserId) return;
    const button = $('#importLegacyJournal');
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const mapping = new Map();
      const staged = legacyTrades.map((oldTrade) => {
        const id = newId();
        mapping.set(String(oldTrade.id), id);
        return { ...oldTrade, id };
      });
      const rows = staged.map((trade) => toCloudTrade(trade, activeUserId));
      const { data, error } = await supabase.from('trades').insert(rows).select('*');
      if (error) throw error;
      const imported = (data || []).map(fromCloudTrade);
      trades.push(...imported);
      let imageCount = 0;
      try {
        const legacyImages = await getAllLegacyScreenshotRecords();
        for (const image of legacyImages) {
          const tradeId = mapping.get(String(image.tradeId));
          if (!tradeId) continue;
          await storeCloudScreenshot(tradeId, { id: newId(), name: image.name || 'screenshot.jpg', blob: image.blob });
          imageCount++;
        }
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
      localStorage.setItem(`${STORAGE_KEY}.migrated.${activeUserId}`, 'true');
      cloudDataLoaded = true;
      renderAll();
      updateLegacyMigrationBanner();
      notify(`Imported ${imported.length} ${imported.length === 1 ? 'trade' : 'trades'}${imageCount ? ` and ${imageCount} ${imageCount === 1 ? 'screenshot' : 'screenshots'}` : ''} into your account.`);
    } catch (error) {
      notify(`Could not import this device's journal: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = 'Import journal';
    }
  }

  function money(value, digits = 2) {
    const abs = Math.abs(value);
    return `${value < 0 ? '−' : ''}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function shortMoney(value) {
    const abs = Math.abs(value);
    const formatted = abs >= 10000 ? `${(abs / 1000).toFixed(1)}k` : abs >= 1000 ? `${(abs / 1000).toFixed(2)}k` : abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return `${value < 0 ? '−' : ''}$${formatted}`;
  }

  function formatDate(dateString, options = { month: 'short', day: 'numeric' }) {
    const date = new Date(`${dateString}T12:00:00`);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', options).format(date);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function iconClass(symbol) {
    if (symbol === 'BTCUSD' || symbol === 'ETHUSD') return 'btc';
    if (symbol === 'EURUSD') return 'fx';
    if (symbol === 'XAUUSD') return 'gold';
    return 'other';
  }

  function symbolGlyph(symbol) {
    return ({ XAUUSD: 'Au', BTCUSD: '₿', EURUSD: '€', ETHUSD: 'Ξ' })[symbol] || '◎';
  }

  function assetName(symbol) {
    return ({ XAUUSD: 'Gold', BTCUSD: 'Bitcoin', EURUSD: 'Euro / USD', ETHUSD: 'Ethereum' })[symbol] || 'Other';
  }

  function filteredByPeriod() {
    if (currentPeriod === 'all') return [...trades];
    const days = Number(currentPeriod);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days + 1);
    const from = localDate(start);
    return trades.filter((trade) => trade.date >= from && trade.date <= localDate(today));
  }

  function closedTrades(list) { return list.filter((trade) => trade.status !== 'open'); }
  function winners(list) { return closedTrades(list).filter((trade) => Number(trade.pnl) > 0); }
  function losers(list) { return closedTrades(list).filter((trade) => Number(trade.pnl) < 0); }
  function totalPnl(list) { return closedTrades(list).reduce((total, trade) => total + Number(trade.pnl || 0), 0); }
  function sumBy(list, key) { return list.reduce((total, trade) => total + Number(trade[key] || 0), 0); }
  function tradeR(trade) { return trade.risk > 0 && trade.status !== 'open' ? trade.pnl / trade.risk : null; }

  function renderAll() {
    $('#navTradeCount').textContent = trades.length;
    $('#todayLabel').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(today);
    $('#sampleBanner').classList.toggle('hidden', !trades.some((trade) => trade.sample));
    renderDashboard();
    renderJournal();
    renderAnalytics();
    renderSettings();
    updateLegacyMigrationBanner();
  }

  function renderDashboard() {
    const list = filteredByPeriod();
    const closed = closedTrades(list);
    const wins = winners(list);
    const losses = losers(list);
    const pnl = totalPnl(list);
    const denominator = wins.length + losses.length;
    const winRate = denominator ? Math.round((wins.length / denominator) * 100) : 0;
    const grossWins = sumBy(wins, 'pnl');
    const grossLosses = Math.abs(sumBy(losses, 'pnl'));
    const pf = grossLosses ? (grossWins / grossLosses).toFixed(2) : grossWins ? '∞' : '—';
    $('#statPnl').textContent = money(pnl);
    $('#statPnl').className = `stat-value ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}`;
    $('#pnlFoot').textContent = pnl > 0 ? '▲ Net positive' : pnl < 0 ? '▼ Net negative' : 'No closed P&L';
    $('#pnlFoot').className = `delta ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral'}`;
    $('#statWin').innerHTML = `${winRate}<span class="value-unit">%</span>`;
    $('#winFoot').textContent = `${wins.length} ${wins.length === 1 ? 'win' : 'wins'}`;
    $('#statTrades').textContent = list.length;
    $('#tradeFoot').textContent = `${list.filter((trade) => trade.status === 'open').length} open`;
    $('#statPF').textContent = pf;
    $('#pfFoot').textContent = grossLosses ? `${money(grossWins, 0)} gross wins` : 'Gross wins ÷ losses';
    $('#chartTotal').textContent = money(pnl);
    renderChart(list);
    const planTrades = closed.filter((trade) => trade.plan === 'yes' || trade.plan === 'no');
    const planCount = planTrades.filter((trade) => trade.plan === 'yes').length;
    const planRate = planTrades.length ? Math.round((planCount / planTrades.length) * 100) : null;
    $('#planRate').textContent = planRate === null ? '—' : `${planRate}%`;
    $('#planRingText').textContent = planRate === null ? '—' : `${planRate}%`;
    $('#planRing').style.background = planRate === null ? '' : `conic-gradient(var(--green) ${planRate * 3.6}deg, #30372d ${planRate * 3.6}deg)`;
    $('#focusMessage').textContent = planRate === null ? 'Mark “followed your plan” when logging a trade to track consistency.' : planRate >= 75 ? 'Strong process discipline. Keep repeating the habits that got you here.' : 'Review the trades where you drifted from your plan. That’s where the learning is.';
    renderRecent(list);
    renderInstrumentBreakdown(list);
  }

  function renderChart(list) {
    const svg = $('#performanceChart');
    const sorted = closedTrades(list).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const points = [];
    let running = 0;
    if (sorted.length) {
      points.push({ date: sorted[0].date, value: 0 });
      for (const trade of sorted) {
        running += Number(trade.pnl || 0);
        points.push({ date: trade.date, value: running });
      }
    } else {
      points.push({ date: localDate(today), value: 0 }, { date: localDate(today), value: 0 });
    }
    const limited = points.length > 35 ? points.filter((_, i) => i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 34) === 0) : points;
    const values = limited.map((p) => p.value);
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    if (min === max) { min -= 50; max += 50; }
    const pad = (max - min) * .13;
    min -= pad; max += pad;
    const x0 = 38, x1 = 710, y0 = 15, y1 = 169;
    const x = (i) => x0 + (limited.length < 2 ? 0 : (i / (limited.length - 1)) * (x1 - x0));
    const y = (value) => y1 - ((value - min) / (max - min)) * (y1 - y0);
    const coords = limited.map((p, i) => `${x(i)},${y(p.value)}`);
    const linePath = coords.map((pt, i) => `${i ? 'L' : 'M'} ${pt}`).join(' ');
    const areaPath = `${linePath} L ${x(limited.length - 1)},${y1} L ${x(0)},${y1} Z`;
    const gridYs = [y0, (y0 + y1) / 2, y1];
    const zeroY = y(0);
    svg.innerHTML = `<defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#b8f078" stop-opacity=".18"/><stop offset="100%" stop-color="#b8f078" stop-opacity="0"/></linearGradient></defs>${gridYs.map((gy) => `<line class="grid-line" x1="${x0}" y1="${gy}" x2="${x1}" y2="${gy}"/>`).join('')}<line class="axis-zero" x1="${x0}" y1="${zeroY}" x2="${x1}" y2="${zeroY}"/><path class="area-fill" d="${areaPath}"/><path class="chart-line" d="${linePath}"/>${limited.length > 1 ? `<circle class="chart-point" cx="${x(limited.length - 1)}" cy="${y(limited[limited.length - 1].value)}" r="4"/>` : ''}`;
    $('#chartYLabels').innerHTML = [max - pad, (max + min) / 2, min + pad].map((value) => `<span>${shortMoney(value)}</span>`).join('');
    const first = sorted[0]?.date;
    const last = sorted.at(-1)?.date;
    const middle = sorted[Math.floor(sorted.length / 2)]?.date;
    const labelDates = sorted.length ? [first, middle, last].filter((date, i, arr) => date && arr.indexOf(date) === i) : [];
    $('#chartXLabels').innerHTML = labelDates.length ? labelDates.map((date) => `<span>${formatDate(date, { month: 'short', day: 'numeric' })}</span>`).join('') : '<span>Start</span><span>Log a trade to see your curve</span><span>Today</span>';
  }

  function tradeRow(trade, full = false) {
    const pnl = Number(trade.pnl || 0);
    const result = trade.status === 'open' ? '<span class="result-open">Open</span>' : `<span class="${pnl > 0 ? 'result-positive' : pnl < 0 ? 'result-negative' : ''}">${money(pnl)}</span>`;
    const entryExit = `${trade.entry === null ? '—' : escapeHtml(trade.entry)} <span style="color:#687068">→</span> ${trade.exit === null ? '—' : escapeHtml(trade.exit)}`;
    const riskValue = tradeR(trade);
    const rText = riskValue === null ? '—' : `${riskValue > 0 ? '+' : ''}${riskValue.toFixed(2)}R`;
    return `<tr data-trade-id="${escapeHtml(trade.id)}"><td class="instrument-cell"><span class="instrument-mini ${iconClass(trade.symbol)}">${escapeHtml(symbolGlyph(trade.symbol))}</span><span class="instrument-name">${escapeHtml(trade.symbol)}<small>${escapeHtml(assetName(trade.symbol))}</small></span></td><td><span class="side-pill ${trade.side.toLowerCase()}">${trade.side === 'Long' ? '↗' : '↘'} ${trade.side}</span></td><td>${escapeHtml(trade.setup || '—')}</td>${full ? `<td class="mono-cell">${entryExit}</td><td class="${riskValue === null ? '' : riskValue > 0 ? 'result-positive' : riskValue < 0 ? 'result-negative' : ''}">${rText}</td><td><span class="plan-pill ${trade.plan}">${trade.plan === 'yes' ? '✓ On plan' : trade.plan === 'no' ? '↗ Deviated' : '—'}</span></td>` : ''}<td>${formatDate(trade.date)}</td><td>${result}</td><td class="row-more">···</td></tr>`;
  }

  function renderRecent(list) {
    const recent = [...list].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 5);
    $('#recentTrades').innerHTML = recent.map((trade) => tradeRow(trade)).join('');
    $('#recentEmpty').classList.toggle('hidden', recent.length > 0);
    $('.recent-panel .table-scroll').classList.toggle('hidden', recent.length === 0);
    const openButton = $('#emptyLogButton');
    openButton.onclick = () => openModal();
  }

  function groupByInstrument(list) {
    const groups = new Map();
    list.forEach((trade) => {
      if (!groups.has(trade.symbol)) groups.set(trade.symbol, []);
      groups.get(trade.symbol).push(trade);
    });
    return [...groups.entries()].map(([symbol, items]) => ({ symbol, items, pnl: totalPnl(items) })).sort((a, b) => b.items.length - a.items.length);
  }

  function renderInstrumentBreakdown(list) {
    const groups = groupByInstrument(list);
    const maxCount = Math.max(1, ...groups.map((group) => group.items.length));
    $('#instrumentBreakdown').innerHTML = groups.length ? groups.slice(0, 5).map((group) => `<div class="instrument-item"><span class="instrument-avatar ${iconClass(group.symbol)}">${escapeHtml(symbolGlyph(group.symbol))}</span><div class="instrument-info"><div class="instrument-info-top"><span>${escapeHtml(assetName(group.symbol))}</span><small>${group.items.length} ${group.items.length === 1 ? 'trade' : 'trades'}</small></div><div class="instrument-bar"><span style="width:${Math.max(8, group.items.length / maxCount * 100)}%"></span></div></div><span class="instrument-pnl ${group.pnl > 0 ? 'result-positive' : group.pnl < 0 ? 'result-negative' : ''}">${money(group.pnl, 0)}</span></div>`).join('') : '<div class="empty-state"><strong>No trades in this period.</strong><span>Log a trade to see your market mix.</span></div>';
  }

  function renderJournal() {
    const search = ($('#tradeSearch')?.value || '').trim().toLowerCase();
    const asset = $('#assetFilter')?.value || 'all';
    const outcome = $('#resultFilter')?.value || 'all';
    const list = [...trades].filter((trade) => {
      const text = [trade.symbol, assetName(trade.symbol), trade.setup, trade.notes, trade.emotion].join(' ').toLowerCase();
      const matchesSearch = !search || text.includes(search);
      const matchesAsset = asset === 'all' || trade.symbol === asset || (asset === 'Other' && !['XAUUSD', 'BTCUSD', 'EURUSD', 'ETHUSD'].includes(trade.symbol));
      const matchesOutcome = outcome === 'all' || (outcome === 'open' ? trade.status === 'open' : trade.status !== 'open' && (outcome === 'win' ? trade.pnl > 0 : trade.pnl < 0));
      return matchesSearch && matchesAsset && matchesOutcome;
    }).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    $('#allTrades').innerHTML = list.map((trade) => tradeRow(trade, true)).join('');
    const empty = list.length === 0;
    $('#journalEmpty').classList.toggle('hidden', !empty);
    $('.journal-panel .table-scroll').classList.toggle('hidden', empty);
    $('#tableCount').textContent = `${list.length} ${list.length === 1 ? 'trade' : 'trades'}`;
    $('#journalFooterCount').textContent = `${trades.length} ${trades.length === 1 ? 'entry' : 'entries'} saved`;
    $('#journalEmptyButton').onclick = () => openModal();
  }

  function renderAnalytics() {
    const closed = closedTrades(trades);
    const wins = winners(trades), losses = losers(trades);
    const avgWin = wins.length ? sumBy(wins, 'pnl') / wins.length : 0;
    const avgLoss = losses.length ? sumBy(losses, 'pnl') / losses.length : 0;
    const rTrades = closed.map((trade) => tradeR(trade)).filter((value) => value !== null);
    const avgR = rTrades.length ? rTrades.reduce((sum, value) => sum + value, 0) / rTrades.length : null;
    const planTrades = closed.filter((trade) => trade.plan === 'yes' || trade.plan === 'no');
    const planRate = planTrades.length ? Math.round((planTrades.filter((trade) => trade.plan === 'yes').length / planTrades.length) * 100) : null;
    $('#avgWinner').textContent = money(avgWin, 0);
    $('#avgWinner').className = `stat-value ${wins.length ? 'positive' : ''}`;
    $('#avgLoser').textContent = money(avgLoss, 0);
    $('#avgLoser').className = `stat-value ${losses.length ? 'negative' : ''}`;
    $('#avgR').textContent = avgR === null ? '—' : `${avgR > 0 ? '+' : ''}${avgR.toFixed(2)}R`;
    $('#avgR').className = `stat-value ${avgR > 0 ? 'positive' : avgR < 0 ? 'negative' : ''}`;
    $('#analyticsPlan').textContent = planRate === null ? '—' : `${planRate}%`;
    const groups = groupByInstrument(trades);
    const maxAbs = Math.max(1, ...groups.map((group) => Math.abs(group.pnl)));
    $('#analyticsInstruments').innerHTML = groups.length ? groups.map((group) => `<div class="analytics-market-row"><div class="analytics-market-name">${escapeHtml(assetName(group.symbol))}<small>${escapeHtml(group.symbol)} · ${group.items.length} trades</small></div><div class="analytics-bar"><span style="width:${Math.max(4, Math.abs(group.pnl) / maxAbs * 100)}%;background:${group.pnl >= 0 ? 'var(--green-dark)' : 'var(--red)'}"></span></div><div class="analytics-result ${group.pnl > 0 ? 'result-positive' : group.pnl < 0 ? 'result-negative' : ''}">${money(group.pnl, 0)}</div></div>`).join('') : '<div class="empty-state"><strong>No instrument data yet.</strong><span>Your market breakdown will show here.</span></div>';
    const setupMap = new Map();
    closed.forEach((trade) => {
      const setup = trade.setup.trim() || 'Uncategorized';
      if (!setupMap.has(setup)) setupMap.set(setup, []);
      setupMap.get(setup).push(trade);
    });
    const setups = [...setupMap.entries()].map(([name, items]) => ({ name, count: items.length, pnl: totalPnl(items) })).sort((a, b) => b.pnl - a.pnl || b.count - a.count);
    $('#setupBreakdown').innerHTML = setups.length ? setups.slice(0, 5).map((setup) => `<div class="setup-row"><span class="setup-name">${escapeHtml(setup.name)}</span><span class="setup-numbers">${setup.count} ${setup.count === 1 ? 'trade' : 'trades'}</span><span class="setup-pnl ${setup.pnl > 0 ? 'result-positive' : setup.pnl < 0 ? 'result-negative' : ''}">${money(setup.pnl, 0)}</span></div>`).join('') : '<div class="empty-state"><strong>No setup data yet.</strong><span>Add a setup name when logging trades.</span></div>';
    const best = [...closed].sort((a, b) => b.pnl - a.pnl)[0];
    const worst = [...closed].sort((a, b) => a.pnl - b.pnl)[0];
    $('#bestTradeText').textContent = best ? `${best.symbol} · ${best.setup || 'Uncategorized'} · ${money(best.pnl)}` : 'Log trades to reveal your standout result.';
    $('#reviewTradeText').textContent = worst && worst.pnl < 0 ? `${worst.symbol} · ${worst.setup || 'Uncategorized'} · ${money(worst.pnl)}. ${worst.notes ? `“${worst.notes}”` : 'What would you change?'}` : 'Your biggest loss can be a useful teacher.';
    $('#processPulseText').textContent = planRate === null ? 'Mark whether you followed your plan to track this habit.' : `${planRate}% of your rated trades followed plan. ${planRate >= 75 ? 'That consistency matters.' : 'Review the moments you drifted.'}`;
    $('#reflectionCount').textContent = `${closed.length} closed ${closed.length === 1 ? 'trade' : 'trades'} reviewed`;
  }

  function renderSettings() {
    $('#settingsTradeCount').textContent = `${trades.length} ${trades.length === 1 ? 'trade' : 'trades'} saved in this browser`;
  }

  function showView(name) {
    $$('.page-content').forEach((view) => view.classList.toggle('hidden', view.id !== `view-${name}`));
    $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
    $('#crumbCurrent').textContent = ({ dashboard: 'Overview', journal: 'Trade journal', analytics: 'Analytics', settings: 'Settings' })[name] || 'Overview';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openModal(trade = null) {
    if (tradeSavePending) return;
    const token = ++modalToken;
    editingId = trade?.id || null;
    releaseGalleryUrls();
    modalScreenshots = [];
    originalScreenshotIds = new Set();
    originalScreenshotMeta = new Map();
    screenshotProcessing = Promise.resolve();
    screenshotTasks = 0;
    tradeSavePending = false;
    screenshotLoadPending = Boolean(trade);
    const form = $('#tradeForm');
    form.reset();
    $('#formError').classList.add('hidden');
    $('#screenshotGallery').innerHTML = '';
    $('#modalTitle').textContent = trade ? 'Review trade' : 'Log a trade';
    $('#saveTradeButton').innerHTML = trade ? 'Save changes <span>↗</span>' : 'Save trade <span>↗</span>';
    $('#deleteTradeButton').classList.toggle('hidden', !trade);
    updateSaveButton();
    if (trade) {
      for (const [name, value] of Object.entries(trade)) {
        const field = form.elements.namedItem(name);
        if (!field) continue;
        if (name === 'side') {
          const radio = form.querySelector(`input[name="side"][value="${value}"]`);
          if (radio) radio.checked = true;
        } else if (field instanceof RadioNodeList) {
          field.value = value;
        } else if (field.type !== 'file') {
          field.value = value ?? '';
        }
      }
    } else {
      form.elements.namedItem('date').value = localDate(new Date());
      form.elements.namedItem('status').value = 'closed';
      form.elements.namedItem('plan').value = 'yes';
      form.elements.namedItem('pnl').value = '';
    }
    $('#tradeModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (trade) {
      getCloudScreenshotsForTrade(trade.id).then((images) => {
        if (token !== modalToken) return;
        modalScreenshots = images.map((image) => ({ ...image, isNew: false }));
        originalScreenshotIds = new Set(images.map((image) => image.id));
        originalScreenshotMeta = new Map(images.map((image) => [image.id, image]));
        renderScreenshotGallery();
      }).catch((error) => {
        if (token !== modalToken) return;
        const formError = $('#formError');
        formError.textContent = `Could not load screenshots: ${error.message}`;
        formError.classList.remove('hidden');
      }).finally(() => {
        if (token === modalToken) {
          screenshotLoadPending = false;
          updateSaveButton();
        }
      });
    }
    setTimeout(() => form.elements.namedItem('symbol').focus(), 20);
  }

  function closeModal() {
    if (tradeSavePending) return;
    modalToken++;
    releaseGalleryUrls();
    modalScreenshots = [];
    originalScreenshotIds = new Set();
    originalScreenshotMeta = new Map();
    screenshotLoadPending = false;
    screenshotTasks = 0;
    tradeSavePending = false;
    $('#tradeModal').classList.add('hidden');
    document.body.style.overflow = '';
    editingId = null;
  }

  function notify(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  function exportCsv() {
    const headers = ['id', 'symbol', 'side', 'setup', 'date', 'entry', 'exit', 'size', 'pnl', 'risk', 'status', 'plan', 'emotion', 'notes'];
    const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const content = [headers, ...trades.map((trade) => headers.map((key) => trade[key] ?? ''))].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    downloadFile(`edgebook-trades-${localDate(new Date())}.csv`, `\ufeff${content}`, 'text/csv;charset=utf-8');
    notify('Journal exported as CSV.');
  }

  async function exportJson() {
    try {
      const screenshots = [];
      for (const trade of trades) {
        const images = await getCloudScreenshotsForTrade(trade.id);
        for (const image of images) {
          const response = await fetch(image.signedUrl);
          if (!response.ok) throw new Error(`Could not download ${image.file_name} for the backup.`);
          screenshots.push({ tradeId: trade.id, name: image.file_name, type: 'image/jpeg', dataUrl: await blobToDataUrl(await response.blob()) });
        }
      }
      const content = JSON.stringify({ app: 'Edgebook', version: 1, exportedAt: new Date().toISOString(), trades, screenshots }, null, 2);
      downloadFile(`edgebook-backup-${localDate(new Date())}.json`, content, 'application/json');
      notify('Journal and screenshots backed up.');
    } catch (error) {
      notify(`Could not create backup: ${error.message}`);
    }
  }

  async function importScreenshots(records, tradeIds) {
    if (!Array.isArray(records) || !records.length) return;
    let count = 0;
    for (const record of records) {
      const tradeId = tradeIds.get(String(record?.tradeId));
      if (!record?.dataUrl || !tradeId) continue;
      await storeCloudScreenshot(tradeId, { id: newId(), name: String(record.name || 'screenshot.jpg'), blob: dataUrlToBlob(record.dataUrl) });
      count++;
    }
    return count;
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function bindEvents() {
    $('#authModeToggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
    $('#authForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!supabase) return;
      const email = $('#authEmail').value.trim();
      const password = $('#authPassword').value;
      $('#authSubmit').disabled = true;
      $('#authSubmit').textContent = authMode === 'signup' ? 'Creating…' : 'Signing in…';
      $('#authMessage').classList.add('hidden');
      try {
        if (authMode === 'signup') {
          const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
          if (error) throw error;
          if (data.session) await handleSession(data.session);
          else authFeedback('Account created. Check your email for the confirmation link, then come back here to sign in.');
        } else {
          const { data, error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;
          await handleSession(data.session);
        }
      } catch (error) {
        authFeedback(error.message || 'Could not sign in. Please try again.', true);
      } finally {
        $('#authSubmit').disabled = false;
        $('#authSubmit').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
      }
    });
    $('#signOutButton').addEventListener('click', async () => {
      if (!supabase) return;
      const { error } = await supabase.auth.signOut();
      if (error) notify(`Could not sign out: ${error.message}`);
    });
    $('#importLegacyJournal').addEventListener('click', importLegacyJournal);
    $('#dismissLegacyImport').addEventListener('click', () => {
      try { localStorage.setItem(`${STORAGE_KEY}.migration-dismissed.${activeUserId}`, 'true'); } catch (error) {}
      $('#localMigrationBanner').classList.add('hidden');
    });
    $$('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
    $$('[data-view="settings"].profile-button').forEach((button) => button.addEventListener('click', () => showView('settings')));
    $$('[data-go="journal"]').forEach((button) => button.addEventListener('click', () => showView('journal')));
    $('#newTradeTop').addEventListener('click', () => openModal());
    $('#journalAddButton').addEventListener('click', () => openModal());
    $('#closeModal').addEventListener('click', closeModal);
    $('#cancelModal').addEventListener('click', closeModal);
    $('#tradeModal').addEventListener('click', (event) => { if (event.target === $('#tradeModal')) closeModal(); });
    $('#deleteTradeButton').addEventListener('click', async () => {
      if (!editingId || !window.confirm('Delete this trade from your journal?')) return;
      const deletedId = editingId;
      try {
        await deleteCloudScreenshotsForTrade(deletedId);
        const { error } = await supabase.from('trades').delete().eq('id', deletedId).eq('user_id', activeUserId);
        if (error) throw error;
      } catch (error) { notify(`Could not delete this trade: ${error.message}`); return; }
      trades = trades.filter((trade) => trade.id !== deletedId);
      closeModal(); renderAll(); notify('Trade deleted.');
    });
    $('#removeSampleTrades').addEventListener('click', async () => {
      const samples = trades.filter((trade) => trade.sample);
      const count = samples.length;
      if (!count) return;
      try {
        const ids = samples.map((trade) => trade.id);
        await deleteCloudScreenshotsForTrades(ids);
        const { error } = await supabase.from('trades').delete().in('id', ids).eq('user_id', activeUserId);
        if (error) throw error;
      } catch (error) { notify(`Could not remove example trades: ${error.message}`); return; }
      trades = trades.filter((trade) => !trade.sample);
      renderAll(); notify(`${count} example ${count === 1 ? 'trade removed' : 'trades removed'}.`);
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#tradeModal').classList.contains('hidden')) closeModal(); });
    $$('.period-switch button').forEach((button) => button.addEventListener('click', () => {
      currentPeriod = button.dataset.period;
      $$('.period-switch button').forEach((item) => item.classList.toggle('selected', item === button));
      renderDashboard();
    }));
    ['tradeSearch', 'assetFilter', 'resultFilter'].forEach((id) => $(`#${id}`).addEventListener(id === 'tradeSearch' ? 'input' : 'change', renderJournal));
    $('#screenshotFiles').addEventListener('change', (event) => {
      const input = event.currentTarget;
      const files = [...(input.files || [])];
      const token = modalToken;
      input.value = '';
      if (!files.length) return;
      screenshotTasks++;
      updateSaveButton();
      screenshotProcessing = screenshotProcessing.then(async () => {
        for (const file of files) {
          try {
            const image = await compressScreenshot(file);
            if (token === modalToken) modalScreenshots.push(image);
          } catch (error) {
            if (token === modalToken) {
              const formError = $('#formError');
              formError.textContent = error.message;
              formError.classList.remove('hidden');
            }
          }
        }
        if (token === modalToken) renderScreenshotGallery();
      }).finally(() => {
        if (token === modalToken) {
          screenshotTasks = Math.max(0, screenshotTasks - 1);
          updateSaveButton();
        }
      });
    });
    $('#screenshotGallery').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-screenshot]');
      if (!button) return;
      modalScreenshots = modalScreenshots.filter((image) => image.id !== button.dataset.removeScreenshot);
      renderScreenshotGallery();
    });
    $('#tradeForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (tradeSavePending) return;
      tradeSavePending = true;
      updateSaveButton();
      await screenshotProcessing;
      if (screenshotLoadPending || screenshotTasks) {
        tradeSavePending = false;
        updateSaveButton();
        return;
      }
      const formData = new FormData(event.currentTarget);
      const pnlInput = formData.get('pnl');
      const status = formData.get('status');
      if (status === 'closed' && (pnlInput === '' || !Number.isFinite(Number(pnlInput)))) {
        const error = $('#formError');
        error.textContent = 'Add the net P&L for a closed trade. Enter 0 for a breakeven trade.';
        error.classList.remove('hidden');
        tradeSavePending = false;
        updateSaveButton();
        return;
      }
      const current = trades.find((trade) => trade.id === editingId);
      const trade = normalizeTrade({
        id: editingId || newId(), symbol: formData.get('symbol'), side: formData.get('side'), setup: formData.get('setup'), date: formData.get('date'),
        entry: formData.get('entry'), exit: formData.get('exit'), size: formData.get('size'), pnl: status === 'open' ? 0 : pnlInput,
        risk: formData.get('risk'), status, plan: formData.get('plan'), emotion: formData.get('emotion'), notes: formData.get('notes')
      });
      try {
        const savedTrade = await saveAccountTrade(trade, Boolean(current));
        if (current) trades = trades.map((item) => item.id === savedTrade.id ? savedTrade : item);
        else trades.unshift(savedTrade);
        editingId = savedTrade.id;
      } catch (error) {
        const formError = $('#formError');
        formError.textContent = `Could not save this trade: ${error.message}`;
        formError.classList.remove('hidden');
        tradeSavePending = false;
        updateSaveButton();
        return;
      }
      try {
        await syncCloudScreenshots(trade.id);
      } catch (error) {
        renderAll();
        const formError = $('#formError');
        formError.textContent = `Trade saved, but a screenshot could not be saved: ${error.message}. Try saving again.`;
        formError.classList.remove('hidden');
        tradeSavePending = false;
        updateSaveButton();
        return;
      }
      tradeSavePending = false;
      closeModal();
      renderAll();
      notify(current ? 'Trade updated.' : 'Trade saved to your journal.');
    });
    $('#recentTrades').addEventListener('click', (event) => {
      const row = event.target.closest('[data-trade-id]');
      if (row) openModal(trades.find((trade) => trade.id === row.dataset.tradeId));
    });
    $('#allTrades').addEventListener('click', (event) => {
      const row = event.target.closest('[data-trade-id]');
      if (row) openModal(trades.find((trade) => trade.id === row.dataset.tradeId));
    });
    $('#exportButton').addEventListener('click', exportCsv);
    $('#analyticsExportButton').addEventListener('click', exportCsv);
    $('#settingsExport').addEventListener('click', exportCsv);
    $('#settingsExportJson').addEventListener('click', exportJson);
    $('#importFile').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const incoming = Array.isArray(parsed) ? parsed : parsed.trades;
        if (!Array.isArray(incoming)) throw new Error('No trades');
        const ids = new Set(trades.map((trade) => trade.id));
        const clean = [];
        const tradeIds = new Map();
        incoming.forEach((source) => {
          const trade = normalizeTrade(source);
          if (!trade) return;
          const originalId = String(source.id || trade.id);
          if (!/^[0-9a-f-]{36}$/i.test(trade.id) || ids.has(trade.id)) trade.id = newId();
          ids.add(trade.id);
          tradeIds.set(originalId, trade.id);
          clean.push(trade);
        });
        if (!clean.length && incoming.length) throw new Error('No usable trades');
        const { data, error } = await supabase.from('trades').insert(clean.map((trade) => toCloudTrade(trade))).select('*');
        if (error) throw error;
        const importedTrades = (data || []).map(fromCloudTrade);
        trades.push(...importedTrades);
        renderAll();
        let imageCount = 0;
        let screenshotImportFailed = false;
        try { imageCount = await importScreenshots(parsed.screenshots, tradeIds) || 0; }
        catch (imageError) { screenshotImportFailed = true; notify(`Trades imported, but some screenshots could not be imported: ${imageError.message}`); }
        if (!screenshotImportFailed) notify(`${importedTrades.length} ${importedTrades.length === 1 ? 'trade' : 'trades'}${imageCount ? ` and ${imageCount} ${imageCount === 1 ? 'screenshot' : 'screenshots'}` : ''} imported.`);
      } catch (error) {
        notify('Could not import that file. Choose an Edgebook JSON backup.');
      } finally {
        event.target.value = '';
      }
    });
  }

  bindEvents();
  renderAll();
  void initializeAuth();
})();
