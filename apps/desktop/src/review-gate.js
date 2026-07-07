/**
 * review-gate.js — HITL review panel logic
 *
 * Shows all repos and branches under review in a clickable list.
 * Click any review to load it into the monitor. Approve/cancel applies
 * to the currently selected review.
 */

const API_BASE = 'http://localhost:3000/api/v1';
let currentThreadId = null;
let allReviews = [];           // All pending reviews from the server
let socket = null;
let pollingInterval = null;

// ===========================================================================
// Electron status updates
// ===========================================================================

if (window.aigov) {
  window.aigov.onStatusUpdate(({ status, message }) => {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');

    dot.className = 'status-dot';
    text.textContent = message;

    switch (status) {
      case 'connected':
        dot.classList.add('green');
        btnStart.style.display = 'none';
        btnStop.style.display = '';
        startPolling();
        connectWebSocket();
        break;
      case 'stopped':
        dot.classList.add('red');
        btnStart.style.display = '';
        btnStop.style.display = 'none';
        disconnectWebSocket();
        stopPolling();
        break;
      case 'error':
        dot.classList.add('red');
        btnStart.style.display = '';
        btnStop.style.display = 'none';
        break;
      default:
        dot.classList.add('amber');
        break;
    }
  });
}

// ===========================================================================
// Engine control
// ===========================================================================

async function startEngine() {
  if (window.aigov) await window.aigov.startEngine();
}

async function stopEngine() {
  if (window.aigov) await window.aigov.stopEngine();
}

// ===========================================================================
// WebSocket — live review streaming
// ===========================================================================

function connectWebSocket() {
  if (socket) return;

  socket = io('http://localhost:3000/reviews', {
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => console.log('[WS] Connected'));

  socket.on('review:started', (data) => {
    // Add to review list
    const exists = allReviews.find((r) => r.threadId === data.threadId);
    if (!exists) {
      allReviews.unshift({
        threadId: data.threadId,
        prNumber: data.prNumber,
        prTitle: data.prTitle,
        owner: data.owner,
        repo: data.repo,
        sourceBranch: data.sourceBranch,
        targetBranch: data.targetBranch,
        author: data.author,
        reviewText: '',
        status: 'reviewing',
        createdAt: new Date().toISOString(),
      });
    }
    if (!currentThreadId) selectReview(data.threadId);
    renderReviewList();
    updateGate('reviewing');
    document.getElementById('review-content').textContent = '';
  });

  socket.on('review:token', (data) => {
    const el = document.getElementById('review-content');
    el.textContent += data.token;
    el.scrollTop = el.scrollHeight;
  });

  socket.on('review:complete', (data) => {
    const el = document.getElementById('review-content');
    if (!el.textContent || el.textContent === 'Fetching diff...') {
      el.textContent = data.reviewText || '';
    }
    const r = allReviews.find((r) => r.threadId === data.threadId);
    if (r) {
      r.reviewText = data.reviewText || '';
      r.status = 'awaiting_approval';
    }
    if (data.threadId === currentThreadId) updateGate('awaiting_approval');
    renderReviewList();
  });

  socket.on('review:status', (data) => {
    const r = allReviews.find((r) => r.threadId === data.threadId);
    if (r) r.status = data.status;
    if (data.threadId === currentThreadId) updateGate(data.status);
    renderReviewList();
  });

  socket.on('disconnect', () => {
    socket = null;
  });
}

function disconnectWebSocket() {
  if (socket) { socket.disconnect(); socket = null; }
}

// ===========================================================================
// Polling — fetch all pending reviews
// ===========================================================================

function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(fetchPendingReviews, 3000);
  fetchPendingReviews();
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

async function fetchPendingReviews() {
  try {
    const res = await fetch(`${API_BASE}/reviews/pending`);
    const reviews = await res.json();

    if (Array.isArray(reviews)) {
      // Merge: update existing, add new
      for (const incoming of reviews) {
        const existing = allReviews.find((r) => r.threadId === incoming.threadId);
        if (existing) {
          Object.assign(existing, incoming);
        } else {
          allReviews.unshift(incoming);
        }
      }

      // Auto-select first review if nothing is selected
      if (!currentThreadId && allReviews.length > 0) {
        selectReview(allReviews[0].threadId);
      }

      renderReviewList();
    }
  } catch {
    // API not available yet
  }
}

// ===========================================================================
// Review list — dropdown of all repos/branches
// ===========================================================================

function renderReviewList() {
  const list = document.getElementById('review-list');
  const countEl = document.getElementById('review-count');
  const countSmall = document.getElementById('review-count-small');

  const pending = allReviews.filter((r) => r.status !== 'done' && r.status !== 'cancelled');

  if (countEl) countEl.textContent = pending.length > 0 ? `${pending.length} review(s)` : '';
  if (countSmall) countSmall.textContent = pending.length > 1 ? `+${pending.length - 1} more` : '';

  list.innerHTML = pending.map((r) => {
    const isActive = r.threadId === currentThreadId;
    const statusEmoji = r.status === 'awaiting_approval' ? '⏸' :
                        r.status === 'reviewing' ? '◐' :
                        r.status === 'posting' ? '▶' : '';
    return `
      <div class="review-list-item ${isActive ? 'active' : ''}" onclick="event.stopPropagation(); selectReview('${r.threadId}')">
        <span class="repo-name">${r.owner}/${r.repo}</span>
        <span class="branch-info">${r.sourceBranch} → ${r.targetBranch}</span>
        <span class="pr-badge" style="font-size:10px;">PR #${r.prNumber}</span>
        <span class="item-status">${statusEmoji} ${r.status}</span>
        <span class="thread-id">${r.threadId.slice(0, 8)}</span>
      </div>
    `;
  }).join('');
}

function toggleReviewList() {
  const list = document.getElementById('review-list');
  list.classList.toggle('open');
}

/**
 * Select a review and load it into the activity board + monitor.
 */
function selectReview(threadId) {
  currentThreadId = threadId;
  const r = allReviews.find((r) => r.threadId === threadId);
  if (!r) return;

  // Close dropdown
  document.getElementById('review-list').classList.remove('open');

  // Update activity board
  document.getElementById('activity-repo').textContent = `${r.owner}/${r.repo}`;
  document.getElementById('activity-branch').textContent = `${r.sourceBranch} → ${r.targetBranch}`;
  document.getElementById('activity-pr').textContent = `PR #${r.prNumber}`;
  document.getElementById('activity-author').textContent = r.author;

  // Update diff pane
  document.getElementById('diff-content').textContent =
    `Diff loaded from PR #${r.prNumber} in ${r.owner}/${r.repo}`;

  // Update review pane
  document.getElementById('review-content').textContent = r.reviewText || '';

  // Update gate
  updateGate(r.status);

  // Fetch scores for this PR
  fetchScores(r.owner, r.repo, r.prNumber);

  renderReviewList();
}

// ===========================================================================
// Score fetching
// ===========================================================================

async function fetchScores(owner, repo, prNumber) {
  try {
    // Fetch audits for the repo, filter for this PR
    const demoRepoId = '00000000-0000-0000-0000-000000000000'; // TODO: map from repo
    const res = await fetch(`${API_BASE}/audits/repo/${demoRepoId}?pageSize=50`);
    const data = await res.json();
    const audits = data.data || [];

    // Find the matching audit
    const audit = audits.find((a) => a.prNumber === prNumber);

    if (audit) {
      updateScore('score-compliance', 'score-bar-c', audit.complianceScore, '#22c55e');
      updateScore('score-efficiency', 'score-bar-e', audit.efficiencyScore, '#3b82f6');
      updateScore('score-coverage', 'score-bar-v', audit.coverageScore, '#8b5cf6');
    } else {
      // Audit may not be complete yet
      updateScore('score-compliance', 'score-bar-c', null, '#22c55e');
      updateScore('score-efficiency', 'score-bar-e', null, '#3b82f6');
      updateScore('score-coverage', 'score-bar-v', null, '#8b5cf6');
    }
  } catch {
    // Scores not available yet
  }
}

function updateScore(valueId, barId, value, color) {
  const valueEl = document.getElementById(valueId);
  const barEl = document.getElementById(barId);
  if (!valueEl || !barEl) return;

  if (value !== null && value !== undefined) {
    valueEl.textContent = `${value}%`;
    valueEl.style.color = color;
    barEl.style.width = `${value}%`;
    barEl.style.background = color;
  } else {
    valueEl.textContent = '—';
    valueEl.style.color = '#475569';
    barEl.style.width = '0%';
  }
}

// ===========================================================================
// Actions
// ===========================================================================

async function approveReview() {
  if (!currentThreadId) return;
  try {
    await fetch(`${API_BASE}/reviews/${currentThreadId}/approve`, { method: 'POST' });
    const r = allReviews.find((r) => r.threadId === currentThreadId);
    if (r) r.status = 'posting';
    updateGate('posting');
    renderReviewList();
  } catch (err) {
    console.error('Approve failed:', err);
  }
}

async function cancelReview() {
  if (!currentThreadId) return;
  try {
    await fetch(`${API_BASE}/reviews/${currentThreadId}/cancel`, { method: 'POST' });
    const r = allReviews.find((r) => r.threadId === currentThreadId);
    if (r) r.status = 'cancelled';
    updateGate('cancelled');
    currentThreadId = null;
    renderReviewList();
    // Auto-select next review
    const next = allReviews.find((r) => r.status === 'awaiting_approval');
    if (next) selectReview(next.threadId);
  } catch (err) {
    console.error('Cancel failed:', err);
  }
}

async function triggerReview() {
  updateGate('reviewing');
}

// ===========================================================================
// UI updates
// ===========================================================================

function updateGate(status) {
  const statusEl = document.getElementById('decision-status');
  const approveBtn = document.getElementById('btn-approve');
  const cancelBtn = document.getElementById('btn-cancel');
  const triggerBtn = document.getElementById('btn-trigger');

  approveBtn.disabled = true;
  cancelBtn.disabled = true;
  triggerBtn.disabled = true;

  switch (status) {
    case 'reviewing':
      statusEl.innerHTML = '<div class="status-dot" style="background:#f59e0b;animation:pulse 1s infinite"></div><span>Analyzing code...</span>';
      break;
    case 'awaiting_approval':
      statusEl.innerHTML = '<div class="status-dot" style="background:#f59e0b;animation:pulse 1s infinite"></div><span>PAUSED: Awaiting Human Approval</span>';
      approveBtn.disabled = false;
      cancelBtn.disabled = false;
      break;
    case 'posting':
      statusEl.innerHTML = '<div class="status-dot" style="background:#22c55e"></div><span>Posting review to GitHub...</span>';
      break;
    case 'done':
      statusEl.innerHTML = '<div class="status-dot" style="background:#22c55e"></div><span>Review posted ✓</span>';
      triggerBtn.disabled = false;
      break;
    case 'cancelled':
      statusEl.innerHTML = '<div class="status-dot" style="background:#64748b"></div><span>Review cancelled</span>';
      triggerBtn.disabled = false;
      break;
    default:
      statusEl.innerHTML = '<div class="status-dot" style="background:#475569"></div><span>No active review</span>';
      break;
  }
}

// Close review list when clicking outside
document.addEventListener('click', (e) => {
  const bar = document.getElementById('activity-bar');
  const list = document.getElementById('review-list');
  if (list.classList.contains('open') && !bar.contains(e.target)) {
    list.classList.remove('open');
  }
});
