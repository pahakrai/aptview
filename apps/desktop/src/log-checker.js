/**
 * log-checker.js — AI-powered log analysis via DeepSeek
 *
 * Flow:
 *   User pastes logs or uploads a file → clicks Analyze
 *   → POST /api/v1/log-analyzer/analyze
 *   → WebSocket receives log-analyzer:complete with results
 *   → Renders structured analysis in output panel
 */

const LOG_API_BASE = 'http://localhost:3000/api/v1/log-analyzer';
let logSocket = null;
let logFileContent = null;
let logFileName = null;
let currentLogThreadId = null;

// ===========================================================================
// Overlay control
// ===========================================================================

function openLogChecker() {
  document.getElementById('log-checker-overlay').classList.add('open');
  connectLogWebSocket();
}

function closeLogChecker() {
  document.getElementById('log-checker-overlay').classList.remove('open');
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
        'Analyzing...';
      document.getElementById('log-output-body').innerHTML =
        '<div class="log-output-placeholder">DeepSeek is analyzing the logs — checking format, extracting errors, searching patterns...</div>';
      document.getElementById('btn-analyze').disabled = true;
      document.getElementById('btn-analyze').textContent = '⏳ Analyzing...';
    }
  });

  logSocket.on('log-analyzer:complete', (data) => {
    if (data.threadId === currentLogThreadId) {
      document.getElementById('log-checker-status').textContent =
        data.status === 'error' ? 'Error' : 'Complete';
      document.getElementById('btn-analyze').disabled = false;
      document.getElementById('btn-analyze').textContent = '⚡ Analyze with DeepSeek';

      if (data.analysisText) {
        renderAnalysis(data.analysisText);
      }
    }
  });

  logSocket.on('disconnect', () => {
    logSocket = null;
  });
}

// ===========================================================================
// File upload
// ===========================================================================

function handleLogFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  logFileName = file.name;
  document.getElementById('log-file-name').textContent = file.name;
  document.getElementById('log-file-clear').style.display = 'inline';

  const reader = new FileReader();
  reader.onload = (e) => {
    logFileContent = e.target.result;
    // Show preview in textarea
    const preview =
      logFileContent.length > 5000
        ? logFileContent.slice(0, 5000) + '\n\n... (truncated in preview, full file will be analyzed)'
        : logFileContent;
    document.getElementById('log-textarea').value = preview;
    updateLogStats();
  };
  reader.readAsText(file);
}

function clearLogFile() {
  logFileContent = null;
  logFileName = null;
  document.getElementById('log-file-input').value = '';
  document.getElementById('log-file-name').textContent = '';
  document.getElementById('log-file-clear').style.display = 'none';
  document.getElementById('log-textarea').value = '';
  updateLogStats();
}

// ===========================================================================
// Textarea monitoring
// ===========================================================================

// Update stats when user types in the textarea
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('log-textarea');
  if (ta) {
    ta.addEventListener('input', updateLogStats);
  }
});

function updateLogStats() {
  const text = document.getElementById('log-textarea').value;
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length;
  const chars = text.length;
  const errors = (text.match(/\b(ERROR|FATAL|CRITICAL|CRIT)\b/gi) || []).length;
  const warns = (text.match(/\bWARN(?:ING)?\b/gi) || []).length;

  const parts = [];
  if (lines > 0) parts.push(`${lines} lines`);
  if (chars > 0) parts.push(`${(chars / 1024).toFixed(1)}KB`);
  if (errors > 0) parts.push(`${errors} errors`);
  if (warns > 0) parts.push(`${warns} warnings`);

  document.getElementById('log-stats').textContent = parts.join(' · ');
}

// ===========================================================================
// Analyze
// ===========================================================================

async function analyzeLogs() {
  const textareaContent = document.getElementById('log-textarea').value.trim();
  const content = logFileContent || textareaContent;

  if (!content) {
    alert('Please paste logs or upload a file first.');
    return;
  }

  if (content.length > 50000) {
    alert(`Log content is ${(content.length / 1024).toFixed(1)}KB. Maximum is ~50KB. Please trim the logs.`);
    return;
  }

  document.getElementById('btn-analyze').disabled = true;
  document.getElementById('btn-analyze').textContent = '⏳ Submitting...';
  document.getElementById('log-checker-status').textContent = 'Submitting...';
  document.getElementById('log-output-body').innerHTML =
    '<div class="log-output-placeholder">Submitting logs for analysis...</div>';

  try {
    const res = await fetch(`${LOG_API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        logContent: content,
        fileName: logFileName || 'pasted-logs.txt',
      }),
    });

    const data = await res.json();
    currentLogThreadId = data.threadId;
    console.log(`[LogChecker] Analysis started: thread ${data.threadId}`);
  } catch (err) {
    console.error('[LogChecker] Submit failed:', err);
    document.getElementById('log-output-body').innerHTML =
      `<div class="log-output-placeholder" style="color:#ef4444">Failed to submit logs: ${err.message}</div>`;
    document.getElementById('btn-analyze').disabled = false;
    document.getElementById('btn-analyze').textContent = '⚡ Analyze with DeepSeek';
    document.getElementById('log-checker-status').textContent = 'Error';
  }
}

// ===========================================================================
// Render analysis results
// ===========================================================================

function renderAnalysis(markdown) {
  const output = document.getElementById('log-output-body');

  // Simple markdown-to-HTML renderer for the analysis output
  let html = markdown;

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="color:#22c55e;font-size:16px;margin:12px 0 8px;">$1</h2>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre>$2</pre>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:16px;">$1</li>');
  html = html.replace(/((?:<li[^>]*>.*<\/li>\s*)+)/g, '<ul style="margin:8px 0;">$1</ul>');

  // Ordered lists (numbered)
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li style="margin-left:16px;">$1</li>');

  // Highlight errors/warnings
  html = html.replace(/\b(ERROR|FATAL|CRITICAL)\b/g, '<span class="error-highlight">$1</span>');
  html = html.replace(/\b(WARN|WARNING)\b/g, '<span class="warn-highlight">$1</span>');

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Wrap paragraphs (avoid wrapping pre/code/h3/h2/li)
  html = '<p>' + html + '</p>';

  output.innerHTML = html;
}
