/**
 * Ved Dashboard — self-contained HTML dashboard.
 *
 * Single-page app served as a string. No external dependencies.
 * Connects to Ved HTTP API for stats, search, history, doctor, and SSE events.
 */

export function getDashboardHtml(baseUrl: string = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ved — Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --radius: 8px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --mono: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  header h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--accent);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  header h1 span { font-size: 1.5rem; }

  .header-status {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    display: inline-block;
    animation: pulse 2s infinite;
  }

  .status-dot.disconnected { background: var(--red); animation: none; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  nav {
    display: flex;
    gap: 4px;
    padding: 8px 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  nav button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
    padding: 8px 16px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 0.85rem;
    font-family: var(--font);
    transition: all 0.15s;
  }

  nav button:hover { color: var(--text); background: rgba(255,255,255,0.05); }
  nav button.active {
    color: var(--accent);
    background: rgba(88,166,255,0.1);
    border-color: var(--accent);
  }

  main { padding: 24px; max-width: 1200px; margin: 0 auto; }

  .panel { display: none; }
  .panel.active { display: block; }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 16px;
  }

  .card h2 {
    font-size: 0.9rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  }

  .stat-item {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    margin-top: 4px;
    font-family: var(--mono);
  }

  .event-stream {
    max-height: 500px;
    overflow-y: auto;
    font-family: var(--mono);
    font-size: 0.8rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }

  .event-entry {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    display: grid;
    grid-template-columns: 140px 160px 1fr;
    gap: 12px;
    align-items: start;
  }

  .event-entry:last-child { border-bottom: none; }

  .event-time { color: var(--text-dim); }
  .event-type {
    color: var(--accent);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .event-detail { color: var(--text); word-break: break-word; }

  .search-bar {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  input[type="text"], input[type="number"], select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    padding: 8px 12px;
    font-family: var(--font);
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s;
  }

  input[type="text"]:focus, select:focus {
    border-color: var(--accent);
  }

  input[type="text"] { flex: 1; }

  button.btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    padding: 8px 20px;
    cursor: pointer;
    font-family: var(--font);
    font-size: 0.9rem;
    font-weight: 500;
    transition: opacity 0.15s;
  }

  button.btn:hover { opacity: 0.85; }
  button.btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .results-list { margin-top: 12px; }

  .result-item {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-bottom: 8px;
  }

  .result-path {
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--accent);
  }

  .result-score {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--yellow);
    float: right;
  }

  .result-snippet {
    margin-top: 6px;
    font-size: 0.85rem;
    color: var(--text-dim);
    white-space: pre-wrap;
    max-height: 100px;
    overflow: hidden;
  }

  .history-filters {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
    align-items: center;
  }

  .history-filters label {
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 2px solid var(--border);
    color: var(--text-dim);
    font-weight: 500;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }

  td.mono {
    font-family: var(--mono);
    font-size: 0.8rem;
  }

  .doctor-checks { list-style: none; }

  .doctor-check {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .doctor-check:last-child { border-bottom: none; }

  .check-icon { font-size: 1.1rem; }
  .check-name { font-weight: 500; }
  .check-detail { color: var(--text-dim); font-size: 0.85rem; margin-left: auto; }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .badge-pass { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-warn { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-fail { background: rgba(248,81,73,0.15); color: var(--red); }

  .empty-state {
    text-align: center;
    padding: 40px;
    color: var(--text-dim);
    font-size: 0.9rem;
  }

  .event-count-badge {
    background: rgba(88,166,255,0.15);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 10px;
    font-family: var(--mono);
    font-size: 0.75rem;
    font-weight: 600;
  }

  @media (max-width: 768px) {
    .event-entry { grid-template-columns: 1fr; gap: 2px; }
    .stats-grid { grid-template-columns: 1fr 1fr; }
    nav { overflow-x: auto; }
    .history-filters { flex-direction: column; }
  }
</style>
</head>
<body>

<header>
  <h1><span>📿</span> Ved Dashboard</h1>
  <div class="header-status">
    <span class="status-dot" id="sse-dot"></span>
    <span id="sse-status">Connecting...</span>
    <span id="uptime"></span>
  </div>
</header>

<nav>
  <button class="active" data-panel="overview">Overview</button>
  <button data-panel="events">Events <span class="event-count-badge" id="event-count">0</span></button>
  <button data-panel="search">Search</button>
  <button data-panel="history">History</button>
  <button data-panel="vault">Vault</button>
  <button data-panel="doctor">Doctor</button>
</nav>

<main>
  <!-- Overview Panel -->
  <div class="panel active" id="panel-overview">
    <div class="card">
      <h2>System Stats</h2>
      <div class="stats-grid" id="stats-grid">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
  </div>

  <!-- Events Panel -->
  <div class="panel" id="panel-events">
    <div class="card">
      <h2>Live Event Stream</h2>
      <div style="margin-bottom: 12px;">
        <input type="text" id="event-filter" placeholder="Filter by type (e.g. message_received, llm_call)" style="width: 100%;">
      </div>
      <div class="event-stream" id="event-stream">
        <div class="empty-state">Waiting for events...</div>
      </div>
    </div>
  </div>

  <!-- Search Panel -->
  <div class="panel" id="panel-search">
    <div class="card">
      <h2>Knowledge Search</h2>
      <div class="search-bar">
        <input type="text" id="search-input" placeholder="Search the vault...">
        <input type="number" id="search-limit" value="5" min="1" max="50" style="width: 80px;">
        <button class="btn" id="search-btn">Search</button>
      </div>
      <div class="results-list" id="search-results">
        <div class="empty-state">Enter a query to search Ved's knowledge vault.</div>
      </div>
    </div>
  </div>

  <!-- History Panel -->
  <div class="panel" id="panel-history">
    <div class="card">
      <h2>Audit History</h2>
      <div class="history-filters">
        <label>Type:</label>
        <select id="history-type">
          <option value="">All</option>
          <option value="message_received">message_received</option>
          <option value="llm_call">llm_call</option>
          <option value="tool_call">tool_call</option>
          <option value="memory_write">memory_write</option>
          <option value="memory_compress">memory_compress</option>
          <option value="trust_change">trust_change</option>
          <option value="work_order_created">work_order_created</option>
          <option value="work_order_approved">work_order_approved</option>
          <option value="work_order_denied">work_order_denied</option>
          <option value="startup">startup</option>
          <option value="shutdown">shutdown</option>
        </select>
        <label>Limit:</label>
        <input type="number" id="history-limit" value="50" min="1" max="500" style="width: 80px;">
        <button class="btn" id="history-btn">Load</button>
        <button class="btn" id="history-verify-btn" style="background: var(--purple);">Verify Chain</button>
      </div>
      <div id="history-results">
        <div class="empty-state">Click Load to fetch audit history.</div>
      </div>
    </div>
  </div>

  <!-- Vault Panel -->
  <div class="panel" id="panel-vault">
    <div class="card">
      <h2>Vault Files</h2>
      <div id="vault-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
    <div class="card" id="vault-content-card" style="display: none;">
      <h2 id="vault-content-title">File</h2>
      <pre style="background: var(--bg); padding: 16px; border-radius: var(--radius); border: 1px solid var(--border); overflow-x: auto; font-family: var(--mono); font-size: 0.8rem; white-space: pre-wrap; max-height: 600px; overflow-y: auto;" id="vault-content"></pre>
    </div>
  </div>

  <!-- Doctor Panel -->
  <div class="panel" id="panel-doctor">
    <div class="card">
      <h2>Diagnostics</h2>
      <button class="btn" id="doctor-btn" style="margin-bottom: 16px;">Run Doctor</button>
      <div id="doctor-results">
        <div class="empty-state">Click Run Doctor to check system health.</div>
      </div>
    </div>
  </div>
</main>

<script>
(function() {
  const BASE = ${JSON.stringify(baseUrl)};

  // ── Navigation ──
  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
    });
  });

  // ── API helpers ──
  const token = new URLSearchParams(window.location.search).get('token');
  function headers() {
    const h = { 'Accept': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function api(path) {
    const res = await fetch(BASE + path, { headers: headers() });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return res.json();
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function fmtTime(ts) {
    const d = new Date(typeof ts === 'number' ? ts : ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDate(ts) {
    const d = new Date(typeof ts === 'number' ? ts : ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  // ── Stats ──
  async function loadStats() {
    try {
      const data = await api('/api/stats');
      const grid = document.getElementById('stats-grid');
      const items = [];

      if (data.vault) {
        items.push({ label: 'Vault Files', value: data.vault.totalFiles ?? '—' });
        items.push({ label: 'Vault Size', value: fmtBytes(data.vault.totalBytes ?? 0) });
      }
      if (data.rag) {
        items.push({ label: 'RAG Indexed', value: data.rag.indexedFiles ?? '—' });
        items.push({ label: 'RAG Vectors', value: data.rag.vectorCount ?? '—' });
      }
      if (data.audit) {
        items.push({ label: 'Audit Entries', value: data.audit.totalEntries ?? '—' });
        items.push({ label: 'Chain Head', value: '#' + (data.audit.chainHead?.count ?? '—') });
      }
      if (data.sessions) {
        items.push({ label: 'Active Sessions', value: data.sessions.active ?? '—' });
        items.push({ label: 'Total Sessions', value: data.sessions.total ?? '—' });
      }
      if (data.sse) {
        items.push({ label: 'SSE Connections', value: data.sse.activeConnections ?? 0 });
        items.push({ label: 'Bus Subscribers', value: data.sse.busSubscribers ?? 0 });
      }
      if (data.cron) {
        items.push({ label: 'Cron Jobs', value: data.cron.totalJobs ?? '—' });
        items.push({ label: 'Cron Enabled', value: data.cron.enabledJobs ?? '—' });
      }

      if (items.length === 0) {
        items.push({ label: 'Status', value: 'OK' });
      }

      grid.innerHTML = items.map(i =>
        '<div class="stat-item"><div class="stat-label">' + esc(i.label) +
        '</div><div class="stat-value">' + esc(i.value) + '</div></div>'
      ).join('');
    } catch (err) {
      document.getElementById('stats-grid').innerHTML =
        '<div class="empty-state">Failed to load stats: ' + esc(err.message) + '</div>';
    }
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Refresh stats every 10s
  loadStats();
  setInterval(loadStats, 10000);

  // ── SSE Events ──
  let eventCount = 0;
  const maxEvents = 200;

  function connectSSE() {
    const dot = document.getElementById('sse-dot');
    const status = document.getElementById('sse-status');

    let url = BASE + '/api/events';
    if (token) url += '?token=' + encodeURIComponent(token);

    const es = new EventSource(url);

    es.onopen = () => {
      dot.className = 'status-dot';
      status.textContent = 'Connected';
    };

    es.onerror = () => {
      dot.className = 'status-dot disconnected';
      status.textContent = 'Reconnecting...';
    };

    // Listen for all event types
    es.onmessage = (e) => {
      addEvent('message', e.data, e.lastEventId);
    };

    // Named events from Ved's SSE
    const eventTypes = [
      'message_received', 'llm_call', 'llm_response', 'tool_call', 'tool_result',
      'memory_write', 'memory_read', 'memory_compress', 'memory_forget',
      'trust_change', 'work_order_created', 'work_order_approved', 'work_order_denied',
      'work_order_executed', 'startup', 'shutdown', 'error',
      'backup_created', 'backup_restored', 'cron_executed', 'migration_applied',
      'vault_change', 'rag_reindex',
    ];

    eventTypes.forEach(type => {
      es.addEventListener(type, (e) => {
        addEvent(type, e.data, e.lastEventId);
      });
    });

    return es;
  }

  function addEvent(type, dataStr, id) {
    const stream = document.getElementById('event-stream');
    const filter = document.getElementById('event-filter').value.trim().toLowerCase();

    // Check filter
    if (filter && !type.toLowerCase().includes(filter)) return;

    eventCount++;
    document.getElementById('event-count').textContent = eventCount;

    // Remove empty state
    const emptyState = stream.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Parse detail
    let detail = '';
    try {
      const parsed = JSON.parse(dataStr);
      if (parsed.detail) {
        detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail);
      } else {
        detail = dataStr.substring(0, 200);
      }
    } catch {
      detail = dataStr.substring(0, 200);
    }

    const entry = document.createElement('div');
    entry.className = 'event-entry';
    entry.innerHTML =
      '<span class="event-time">' + esc(fmtTime(Date.now())) + '</span>' +
      '<span class="event-type">' + esc(type) + '</span>' +
      '<span class="event-detail">' + esc(detail) + '</span>';

    stream.prepend(entry);

    // Trim old entries
    while (stream.children.length > maxEvents) {
      stream.removeChild(stream.lastChild);
    }
  }

  // Filter events on input change
  document.getElementById('event-filter').addEventListener('input', () => {
    // Filter only affects new events (existing ones stay)
  });

  connectSSE();

  // ── Search ──
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('search-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  async function doSearch() {
    const q = document.getElementById('search-input').value.trim();
    const n = document.getElementById('search-limit').value;
    const results = document.getElementById('search-results');

    if (!q) return;

    results.innerHTML = '<div class="empty-state">Searching...</div>';

    try {
      const data = await api('/api/search?q=' + encodeURIComponent(q) + '&n=' + n);
      const items = data.results || [];

      if (items.length === 0) {
        results.innerHTML = '<div class="empty-state">No results found.</div>';
        return;
      }

      results.innerHTML = items.map(r =>
        '<div class="result-item">' +
        '<span class="result-score">score: ' + esc((r.score ?? r.fusedScore ?? 0).toFixed(3)) + '</span>' +
        '<div class="result-path">' + esc(r.path ?? r.file ?? '—') + '</div>' +
        '<div class="result-snippet">' + esc(r.snippet ?? r.content ?? '—') + '</div>' +
        '</div>'
      ).join('');
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Search failed: ' + esc(err.message) + '</div>';
    }
  }

  // ── History ──
  document.getElementById('history-btn').addEventListener('click', loadHistory);
  document.getElementById('history-verify-btn').addEventListener('click', verifyChain);

  async function loadHistory() {
    const type = document.getElementById('history-type').value;
    const limit = document.getElementById('history-limit').value;
    const results = document.getElementById('history-results');

    results.innerHTML = '<div class="empty-state">Loading...</div>';

    try {
      let url = '/api/history?limit=' + limit;
      if (type) url += '&type=' + encodeURIComponent(type);

      const data = await api(url);
      const entries = data.entries || [];

      if (entries.length === 0) {
        results.innerHTML = '<div class="empty-state">No audit entries found.</div>';
        return;
      }

      let html = '<table><thead><tr><th>Time</th><th>Type</th><th>Actor</th><th>Session</th><th>Detail</th></tr></thead><tbody>';

      entries.forEach(e => {
        const detail = typeof e.detail === 'string'
          ? e.detail.substring(0, 100)
          : JSON.stringify(e.detail ?? {}).substring(0, 100);

        html += '<tr>' +
          '<td class="mono">' + esc(fmtDate(e.timestamp ?? e.ts)) + '</td>' +
          '<td class="mono" style="color:var(--accent);">' + esc(e.eventType ?? e.event_type) + '</td>' +
          '<td class="mono">' + esc(e.actor ?? '—') + '</td>' +
          '<td class="mono" style="color:var(--text-dim);">' + esc((e.sessionId ?? e.session_id ?? '').substring(0, 8)) + '</td>' +
          '<td>' + esc(detail) + '</td>' +
          '</tr>';
      });

      html += '</tbody></table>';
      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  async function verifyChain() {
    const results = document.getElementById('history-results');
    results.innerHTML = '<div class="empty-state">Verifying hash chain...</div>';

    try {
      const data = await api('/api/history?verify=true&limit=1');
      if (data.chainValid === true) {
        results.innerHTML = '<div class="empty-state" style="color:var(--green);">✅ Hash chain verified — ' + (data.chainLength ?? '?') + ' entries, all intact.</div>';
      } else {
        results.innerHTML = '<div class="empty-state" style="color:var(--red);">❌ Chain verification failed at entry ' + (data.brokenAt ?? '?') + '</div>';
      }
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Verification failed: ' + esc(err.message) + '</div>';
    }
  }

  // ── Vault ──
  async function loadVault() {
    const list = document.getElementById('vault-list');

    try {
      const data = await api('/api/vault/files');
      const files = data.files || [];

      if (files.length === 0) {
        list.innerHTML = '<div class="empty-state">No vault files found.</div>';
        return;
      }

      // Group by directory
      const groups = {};
      files.forEach(f => {
        const path = f.path ?? f;
        const parts = path.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
        if (!groups[dir]) groups[dir] = [];
        groups[dir].push(path);
      });

      let html = '';
      Object.keys(groups).sort().forEach(dir => {
        html += '<div style="margin-bottom: 12px;">';
        html += '<div style="color:var(--text-dim); font-size:0.8rem; margin-bottom:4px;">📁 ' + esc(dir) + '/</div>';
        groups[dir].sort().forEach(path => {
          const name = path.split('/').pop();
          html += '<div style="padding:4px 0 4px 16px;">' +
            '<a href="#" style="color:var(--accent); text-decoration:none; font-family:var(--mono); font-size:0.85rem;" ' +
            'data-path="' + esc(path) + '" class="vault-file-link">📄 ' + esc(name) + '</a></div>';
        });
        html += '</div>';
      });

      list.innerHTML = html;

      // Attach click handlers
      list.querySelectorAll('.vault-file-link').forEach(link => {
        link.addEventListener('click', async (e) => {
          e.preventDefault();
          const path = link.dataset.path;
          await loadVaultFile(path);
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="empty-state">Failed: ' + esc(err.message) + '</div>';
    }
  }

  async function loadVaultFile(path) {
    const card = document.getElementById('vault-content-card');
    const title = document.getElementById('vault-content-title');
    const content = document.getElementById('vault-content');

    card.style.display = 'block';
    title.textContent = path;
    content.textContent = 'Loading...';

    try {
      const data = await api('/api/vault/file?path=' + encodeURIComponent(path));
      content.textContent = data.content ?? '(empty)';
    } catch (err) {
      content.textContent = 'Error: ' + err.message;
    }
  }

  loadVault();

  // ── Doctor ──
  document.getElementById('doctor-btn').addEventListener('click', async () => {
    const results = document.getElementById('doctor-results');
    const btn = document.getElementById('doctor-btn');

    btn.disabled = true;
    btn.textContent = 'Running...';
    results.innerHTML = '<div class="empty-state">Running diagnostics...</div>';

    try {
      const data = await api('/api/doctor');
      const checks = data.checks || [];

      if (checks.length === 0) {
        results.innerHTML = '<div class="empty-state">No diagnostics returned.</div>';
        return;
      }

      let html = '<ul class="doctor-checks">';
      checks.forEach(c => {
        const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
        const badgeClass = c.status === 'pass' ? 'badge-pass' : c.status === 'warn' ? 'badge-warn' : 'badge-fail';

        html += '<li class="doctor-check">' +
          '<span class="check-icon">' + icon + '</span>' +
          '<span class="check-name">' + esc(c.name) + '</span>' +
          '<span class="badge ' + badgeClass + '">' + esc(c.status) + '</span>' +
          '<span class="check-detail">' + esc(c.detail ?? c.message ?? '') + '</span>' +
          '</li>';
      });
      html += '</ul>';

      // Summary
      const passed = checks.filter(c => c.status === 'pass').length;
      const warns = checks.filter(c => c.status === 'warn').length;
      const fails = checks.filter(c => c.status === 'fail').length;
      html += '<div style="margin-top: 12px; font-size: 0.85rem; color: var(--text-dim);">' +
        passed + ' passed, ' + warns + ' warnings, ' + fails + ' failures</div>';

      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = '<div class="empty-state">Doctor failed: ' + esc(err.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run Doctor';
    }
  });
})();
</script>
</body>
</html>`;
}
