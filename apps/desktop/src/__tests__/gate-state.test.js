/**
 * gate-state.test.js — Unit tests for the HITL gate state machine.
 *
 * Tests updateGate(), selectReview(), renderReviewList(), and action functions
 * (approve, cancel, revise) across all gate states.
 *
 * @jest-environment jsdom
 */

// ============================================================================
// Setup — mirror the globals from review-gate.js
// ============================================================================

global.API_BASE = 'http://localhost:3000/api/v1';
global.MAX_REVISIONS = 3;
global.currentThreadId = null;
global.allReviews = [];
global.fetch = jest.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
);

const sampleReview = (overrides = {}) => ({
  threadId: 'thread-001',
  prNumber: 42,
  prTitle: 'Add email validation',
  owner: 'acme',
  repo: 'api',
  sourceBranch: 'feat/auth',
  targetBranch: 'main',
  author: 'dev',
  reviewText: '## Code Review\n\nLGTM',
  status: 'awaiting_approval',
  revisionCount: 0,
  createdAt: '2026-07-19T00:00:00Z',
  ...overrides,
});

function fullDOM() {
  document.body.innerHTML = `
    <div id="status-bar">
      <div id="status-dot" class="status-dot amber"></div>
      <span id="status-text">Starting...</span>
      <span id="review-count"></span>
      <button id="btn-retry" style="display:none">Retry Connection</button>
    </div>
    <div id="activity-bar">
      <span id="activity-repo">—</span>
      <span id="activity-branch">—</span>
      <span id="activity-pr">PR #—</span>
      <span id="activity-author">—</span>
      <span id="review-count-small"></span>
      <div id="review-list"></div>
    </div>
    <div id="diff-content"></div>
    <div id="review-content"></div>
    <div id="reviewer-controls">
      <span class="revision-badge" id="revision-badge">0 / 3</span>
      <span id="revision-hint">3 revision round(s) remaining</span>
      <textarea id="feedback-input"></textarea>
      <button class="btn-revise" id="btn-revise">Revise &amp; Re-generate</button>
      <textarea id="notes-input"></textarea>
    </div>
    <div id="decision-gate">
      <div class="decision-status" id="decision-status"><span>placeholder</span></div>
      <button class="btn btn-primary" id="btn-approve" disabled>Approve &amp; Comment</button>
      <button class="btn btn-danger" id="btn-cancel" disabled>Cancel Review</button>
    </div>
  `;
}

// ============================================================================
// Gate State Machine — updateGate()
// ============================================================================

describe('updateGate — gate state machine', () => {
  beforeEach(() => {
    fullDOM();
    global.currentThreadId = 'thread-001';
    global.allReviews = [sampleReview()];
  });

  // ----- awaiting_approval (first round) -----

  test('awaiting_approval (first round): approve and cancel enabled, revise enabled', () => {
    updateGate('awaiting_approval');

    expect(document.getElementById('btn-approve').disabled).toBe(false);
    expect(document.getElementById('btn-cancel').disabled).toBe(false);
    expect(document.getElementById('btn-revise').disabled).toBe(false);
    expect(document.getElementById('reviewer-controls').classList.contains('visible')).toBe(true);
  });

  test('awaiting_approval (first round): shows correct revision badge and hint', () => {
    updateGate('awaiting_approval');

    expect(document.getElementById('revision-badge').textContent).toBe('0 / 3');
    expect(document.getElementById('revision-hint').textContent).toBe('3 revision round(s) remaining');
    expect(document.getElementById('revision-badge').classList.contains('depleted')).toBe(false);
  });

  test('awaiting_approval (first round): status shows "Awaiting Human Approval" without revision count', () => {
    updateGate('awaiting_approval');

    const statusHTML = document.getElementById('decision-status').innerHTML;
    expect(statusHTML).toContain('Awaiting Human Approval');
    expect(statusHTML).not.toContain('Revision');
  });

  // ----- awaiting_approval (after revision) -----

  test('awaiting_approval (after 1 revision): shows revision count in status', () => {
    global.allReviews = [sampleReview({ revisionCount: 1 })];

    updateGate('awaiting_approval');

    const statusHTML = document.getElementById('decision-status').innerHTML;
    expect(statusHTML).toContain('Revision 1');
    expect(document.getElementById('revision-badge').textContent).toBe('1 / 3');
    expect(document.getElementById('revision-hint').textContent).toBe('2 revision round(s) remaining');
  });

  test('awaiting_approval (after 2 revisions): 1 round remaining', () => {
    global.allReviews = [sampleReview({ revisionCount: 2 })];

    updateGate('awaiting_approval');

    expect(document.getElementById('revision-badge').textContent).toBe('2 / 3');
    expect(document.getElementById('revision-hint').textContent).toBe('1 revision round(s) remaining');
    expect(document.getElementById('btn-revise').disabled).toBe(false);
  });

  // ----- awaiting_approval (max revisions) -----

  test('awaiting_approval (max reached): approve/cancel enabled, revise DISABLED', () => {
    global.allReviews = [sampleReview({ revisionCount: 3 })];

    updateGate('awaiting_approval');

    expect(document.getElementById('btn-approve').disabled).toBe(false);
    expect(document.getElementById('btn-cancel').disabled).toBe(false);
    expect(document.getElementById('btn-revise').disabled).toBe(true);
  });

  test('awaiting_approval (max reached): revise button shows depleted text', () => {
    global.allReviews = [sampleReview({ revisionCount: 3 })];

    updateGate('awaiting_approval');

    expect(document.getElementById('btn-revise').textContent).toBe('No Revisions Left');
    expect(document.getElementById('revision-badge').classList.contains('depleted')).toBe(true);
    expect(document.getElementById('revision-badge').textContent).toBe('3 / 3');
  });

  test('awaiting_approval (max reached): feedback textarea disabled', () => {
    global.allReviews = [sampleReview({ revisionCount: 3 })];

    updateGate('awaiting_approval');

    expect(document.getElementById('feedback-input').disabled).toBe(true);
    expect(document.getElementById('feedback-input').placeholder).toBe('Maximum revision rounds reached');
  });

  test('awaiting_approval (max reached): hint shows no rounds remaining', () => {
    global.allReviews = [sampleReview({ revisionCount: 3 })];

    updateGate('awaiting_approval');

    expect(document.getElementById('revision-hint').textContent).toBe(
      'No revision rounds remaining — approve or cancel'
    );
  });

  // ----- reviewing -----

  test('reviewing: all action buttons disabled, controls hidden', () => {
    updateGate('reviewing');

    expect(document.getElementById('btn-approve').disabled).toBe(true);
    expect(document.getElementById('btn-cancel').disabled).toBe(true);
    expect(document.getElementById('btn-revise').disabled).toBe(true);
    expect(document.getElementById('reviewer-controls').classList.contains('visible')).toBe(false);
  });

  test('reviewing: status shows analyzing text', () => {
    updateGate('reviewing');

    expect(document.getElementById('decision-status').innerHTML).toContain('Analyzing code');
  });

  // ----- posting -----

  test('posting: buttons disabled, controls hidden', () => {
    updateGate('posting');

    expect(document.getElementById('btn-approve').disabled).toBe(true);
    expect(document.getElementById('btn-cancel').disabled).toBe(true);
    expect(document.getElementById('reviewer-controls').classList.contains('visible')).toBe(false);
  });

  test('posting: status shows posting text', () => {
    updateGate('posting');

    expect(document.getElementById('decision-status').innerHTML).toContain('Posting review');
  });

  // ----- done -----

  test('done: buttons disabled, controls hidden', () => {
    updateGate('done');

    expect(document.getElementById('btn-approve').disabled).toBe(true);
    expect(document.getElementById('btn-cancel').disabled).toBe(true);
    expect(document.getElementById('reviewer-controls').classList.contains('visible')).toBe(false);
  });

  test('done: status shows checkmark', () => {
    updateGate('done');

    expect(document.getElementById('decision-status').innerHTML).toContain('Review posted');
  });

  // ----- cancelled -----

  test('cancelled: all disabled, controls hidden', () => {
    updateGate('cancelled');

    expect(document.getElementById('btn-approve').disabled).toBe(true);
    expect(document.getElementById('reviewer-controls').classList.contains('visible')).toBe(false);
  });

  test('cancelled: status shows cancelled text', () => {
    updateGate('cancelled');

    expect(document.getElementById('decision-status').innerHTML).toContain('Review cancelled');
  });

  // ----- no active review -----

  test('no active review: everything locked when currentThreadId is null', () => {
    global.currentThreadId = null;
    global.allReviews = [];

    updateGate('done');

    expect(document.getElementById('btn-approve').disabled).toBe(true);
    expect(document.getElementById('btn-cancel').disabled).toBe(true);
    expect(document.getElementById('btn-revise').disabled).toBe(true);
    expect(document.getElementById('reviewer-controls').classList.contains('visible')).toBe(false);
  });
});

// ============================================================================
// selectReview()
// ============================================================================

describe('selectReview', () => {
  beforeEach(() => {
    fullDOM();
    global.allReviews = [sampleReview(), sampleReview({ threadId: 'thread-002', prNumber: 99 })];
    global.currentThreadId = 'thread-001';
  });

  test('updates activity board with review metadata', () => {
    selectReview('thread-001');

    expect(document.getElementById('activity-repo').textContent).toBe('acme/api');
    expect(document.getElementById('activity-branch').textContent).toBe('feat/auth → main');
    expect(document.getElementById('activity-pr').textContent).toBe('PR #42');
    expect(document.getElementById('activity-author').textContent).toBe('dev');
  });

  test('loads review text into review-content pane', () => {
    selectReview('thread-001');

    expect(document.getElementById('review-content').textContent).toBe('## Code Review\n\nLGTM');
  });

  test('clears notes and feedback inputs on switch', () => {
    document.getElementById('notes-input').value = 'old notes';
    document.getElementById('feedback-input').value = 'old feedback';

    selectReview('thread-002');

    expect(document.getElementById('notes-input').value).toBe('');
    expect(document.getElementById('feedback-input').value).toBe('');
  });

  test('sets currentThreadId to selected review', () => {
    selectReview('thread-002');

    expect(global.currentThreadId).toBe('thread-002');
  });

  test('does nothing if threadId not found', () => {
    selectReview('nonexistent');

    // currentThreadId unchanged
    expect(global.currentThreadId).toBe('thread-001');
  });

  test('closes review list dropdown', () => {
    document.getElementById('review-list').classList.add('open');

    selectReview('thread-001');

    expect(document.getElementById('review-list').classList.contains('open')).toBe(false);
  });
});

// ============================================================================
// renderReviewList()
// ============================================================================

describe('renderReviewList', () => {
  beforeEach(() => {
    fullDOM();
    global.currentThreadId = 'thread-001';
  });

  test('renders pending reviews with repo/branch/PR info', () => {
    global.allReviews = [sampleReview()];

    renderReviewList();

    const html = document.getElementById('review-list').innerHTML;
    expect(html).toContain('acme/api');
    expect(html).toContain('feat/auth → main');
    expect(html).toContain('PR #42');
  });

  test('filters out done and cancelled reviews', () => {
    global.allReviews = [
      sampleReview({ threadId: 't1', status: 'done' }),
      sampleReview({ threadId: 't2', status: 'cancelled' }),
      sampleReview({ threadId: 't3', status: 'awaiting_approval' }),
    ];

    renderReviewList();

    const html = document.getElementById('review-list').innerHTML;
    expect(html).toContain('t3');
    expect(html).not.toContain('t1');
    expect(html).not.toContain('t2');
  });

  test('shows revision badge when count > 0', () => {
    global.allReviews = [sampleReview({ revisionCount: 2 })];

    renderReviewList();

    expect(document.getElementById('review-list').innerHTML).toContain('rev2');
  });

  test('no revision badge when count is 0', () => {
    global.allReviews = [sampleReview({ revisionCount: 0 })];

    renderReviewList();

    expect(document.getElementById('review-list').innerHTML).not.toContain('rev0');
  });

  test('marks active review with active class', () => {
    global.allReviews = [sampleReview({ threadId: 'thread-001' })];

    renderReviewList();

    expect(document.getElementById('review-list').innerHTML).toContain('active');
  });

  test('shows review count when reviews exist', () => {
    global.allReviews = [sampleReview(), sampleReview({ threadId: 't2' })];

    renderReviewList();

    expect(document.getElementById('review-count').textContent).toBe('2 review(s)');
  });

  test('shows empty count when no pending reviews', () => {
    global.allReviews = [sampleReview({ status: 'done' })];

    renderReviewList();

    expect(document.getElementById('review-count').textContent).toBe('');
  });
});

// ============================================================================
// Action functions — approve, cancel, revise (API interaction)
// ============================================================================

describe('action functions — API interaction', () => {
  beforeEach(() => {
    fullDOM();
    global.currentThreadId = 'thread-001';
    global.allReviews = [sampleReview()];
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    );
    window.alert = jest.fn();
  });

  // ----- approveReview -----

  test('approveReview: sends correct action with no notes', async () => {
    await approveReview();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/reviews/thread-001/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      })
    );
  });

  test('approveReview: includes notes when textarea has content', async () => {
    document.getElementById('notes-input').value = 'Check auth flow carefully';

    await approveReview();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ action: 'approve', notes: 'Check auth flow carefully' }),
      })
    );
  });

  test('approveReview: ignores whitespace-only notes', async () => {
    document.getElementById('notes-input').value = '   ';

    await approveReview();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ action: 'approve' }),
      })
    );
  });

  test('approveReview: returns early when no threadId', async () => {
    global.currentThreadId = null;

    await approveReview();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ----- cancelReview -----

  test('cancelReview: sends cancel action', async () => {
    await cancelReview();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/reviews/thread-001/action',
      expect.objectContaining({
        body: JSON.stringify({ action: 'cancel' }),
      })
    );
  });

  test('cancelReview: clears currentThreadId and auto-selects next pending', async () => {
    global.allReviews = [
      sampleReview({ threadId: 't1' }),
      sampleReview({ threadId: 't2', prNumber: 99, status: 'awaiting_approval' }),
    ];
    global.currentThreadId = 't1';

    await cancelReview();

    expect(global.currentThreadId).toBe('t2');
  });

  test('cancelReview: sets currentThreadId to null when no remaining pending', async () => {
    global.allReviews = [sampleReview({ threadId: 't1' })];
    global.currentThreadId = 't1';

    await cancelReview();

    expect(global.currentThreadId).toBeNull();
  });

  // ----- reviseReview -----

  test('reviseReview: sends revise action with feedback', async () => {
    document.getElementById('feedback-input').value = 'Check error handling';

    await reviseReview();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/reviews/thread-001/action',
      expect.objectContaining({
        body: JSON.stringify({ action: 'revise', feedback: 'Check error handling' }),
      })
    );
  });

  test('reviseReview: alerts when feedback is empty', () => {
    document.getElementById('feedback-input').value = '';

    reviseReview();

    expect(window.alert).toHaveBeenCalledWith(
      'Please enter feedback describing what you want the AI to re-check.'
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('reviseReview: alerts when max revisions reached', () => {
    global.allReviews = [sampleReview({ revisionCount: 3 })];
    document.getElementById('feedback-input').value = 'try again';

    reviseReview();

    expect(window.alert).toHaveBeenCalledWith(
      'Maximum revision rounds (3) reached. Please approve or cancel.'
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('reviseReview: disables button while in-flight', async () => {
    document.getElementById('feedback-input').value = 'check auth';
    const btn = document.getElementById('btn-revise');

    await reviseReview();

    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Revising...');
  });

  test('reviseReview: clears feedback input on success', async () => {
    document.getElementById('feedback-input').value = 'check auth';
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ revisionCount: 1, remaining: 2 }),
      })
    );

    await reviseReview();

    expect(document.getElementById('feedback-input').value).toBe('');
  });
});
