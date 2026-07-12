/**
 * log-checker.js — AI-powered K8s cluster debugging via Kubetail MCP + DeepSeek
 *
 * Flow:
 *   User types a question or clicks a suggestion → clicks Analyze
 *   → POST /api/v1/log-analyzer/analyze with the prompt
 *   → Backend invokes LangGraph + DeepSeek with Kubetail MCP tools
 *   → DeepSeek calls MCP tools to fetch logs from K8s cluster
 *   → WebSocket streams tokens in real-time
 *   → Renders structured diagnostic report
 */

const LOG_API_BASE = 'http://localhost:3000/api/v1/log-analyzer';
let logSocket = null;
let currentLogThreadId = null;

// ===========================================================================
// Overlay control
// ===========================================================================

function openLogChecker() {
  document.getElementById('log-checker-overlay').classList.add('open');
  connectLogWebSocket();
  document.getElementById('prompt-input').focus();
}

function closeLogChecker() {
  document.getElementById('log-checker-overlay').classList.remove('open');
}

// ===========================================================================
// Prompt suggestions
// ===========================================================================

function usePrompt(chip) {
  const text = chip.textContent.trim();
  document.getElementById('prompt-input').value = text;
  document.getElementById('prompt-input').focus();
}

// ===========================================================================
// WebSocket for log analysis
// ===========================================================================

function connectLogWebSocket() {
  if (logSocket) return;

  logSocket = io('http://localhost:3000/log-analyzer', {
    transports: ['websocket', 'polling'],
  });

  logSocket.on('connect', () => {
    console.log('[LogChecker:WS] Connected');
  });

  logSocket.on('log-analyzer:started', (data) => {
    if (data.threadId === currentLogThreadId) {
      document.getElementById('log-checker-status').textContent =
        'Fetching cluster data...';
      document.getElementById('log-output-body').innerHTML = '';
    }
  });

  // Streaming tokens — append each token to the output in real-time
  logSocket.on('log-analyzer:token', (data) => {
    if (data.threadId === currentLogThreadId && data.token) {
      const body = document.getElementById('log-output-body');
      if (!body.dataset.streaming || body.dataset.streaming === 'false') {
        body.innerHTML = '';
        body.dataset.streaming = 'true';
      }
      body.textContent += data.token;
      body.scrollTop = body.scrollHeight;
    }
  });

  logSocket.on('log-analyzer:complete', (data) => {
    if (data.threadId === currentLogThreadId) {
      const statusLabels = {
        complete: 'Complete',
        error: 'Error',
        cancelled: 'Cancelled',
      };
      document.getElementById('log-checker-status').textContent =
        statusLabels[data.status] || data.status || 'Done';

      setButtonMode('analyze');

      if (data.analysisText) {
        const body = document.getElementById('log-output-body');
        body.dataset.streaming = 'false';
        renderAnalysis(data.analysisText);
      }

      if (data.status === 'complete' || data.status === 'error' || data.status === 'cancelled') {
        currentLogThreadId = null;
      }
    }
  });

  logSocket.on('disconnect', () => {
    logSocket = null;
  });
}

// ===========================================================================
// Analyze / Cancel
// ===========================================================================

function analyzeLogs() {
  // If already analyzing, cancel instead
  if (currentLogThreadId && document.getElementById('btn-analyze').dataset.mode === 'cancel') {
    return cancelLogAnalysis();
  }

  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt) {
    alert('Please type a question or click a suggestion.');
    return;
  }

  setButtonMode('cancel');
  document.getElementById('log-checker-status').textContent = 'Submitting...';
  document.getElementById('log-output-body').innerHTML =
    '<div class="log-output-placeholder">Submitting query to DeepSeek + Kubetail MCP...</div>';

  fetch(`${LOG_API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      logContent: prompt,
      fileName: 'cluster-query',
    }),
  })
    .then((res) => res.json())
    .then((data) => {
      currentLogThreadId = data.threadId;
      console.log(`[LogChecker] Analysis started: thread ${data.threadId}`);
    })
    .catch((err) => {
      console.error('[LogChecker] Submit failed:', err);
      document.getElementById('log-output-body').innerHTML =
        `<div class="log-output-placeholder" style="color:#ef4444">Failed to submit query: ${err.message}</div>`;
      setButtonMode('analyze');
      document.getElementById('log-checker-status').textContent = 'Error';
    });
}

async function cancelLogAnalysis() {
  if (!currentLogThreadId) return;

  setButtonMode('analyze');
  document.getElementById('btn-analyze').textContent = '⏳ Cancelling...';
  document.getElementById('log-checker-status').textContent = 'Cancelling...';

  try {
    await fetch(`${LOG_API_BASE}/${currentLogThreadId}/cancel`, { method: 'POST' });
  } catch (err) {
    console.error('[LogChecker] Cancel failed:', err);
  }
}

function setButtonMode(mode) {
  const btn = document.getElementById('btn-analyze');
  btn.dataset.mode = mode;
  btn.disabled = false;

  if (mode === 'cancel') {
    btn.className = 'btn btn-danger';
    btn.textContent = '⏹ Cancel';
  } else {
    btn.className = 'btn btn-accent';
    btn.textContent = '⚡ Analyze';
  }
}

// ===========================================================================
// Render analysis results
// ===========================================================================

function renderAnalysis(markdown) {
  const output = document.getElementById('log-output-body');
  let html = markdown;

  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="color:#22c55e;font-size:16px;margin:12px 0 8px;">$1</h2>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre>$2</pre>');
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:16px;">$1</li>');
  html = html.replace(/((?:<li[^>]*>.*<\/li>\s*)+)/g, '<ul style="margin:8px 0;">$1</ul>');
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li style="margin-left:16px;">$1</li>');
  html = html.replace(/\b(ERROR|FATAL|CRITICAL|CrashLoopBackOff|OOMKilled)\b/g, '<span class="error-highlight">$1</span>');
  html = html.replace(/\b(WARN|WARNING)\b/g, '<span class="warn-highlight">$1</span>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';

  output.innerHTML = html;
}
