/**
 * setup.js — Jest setup file for desktop app tests.
 *
 * Loads review-gate.js into the global scope so tests can call
 * updateGate(), selectReview(), renderReviewList(), etc.
 *
 * jsdom provides a browser-like DOM environment.
 */

const { JSDOM } = require('jsdom');

// Provide minimal DOM so review-gate.js can load without crashing.
// Tests will call fullDOM() to set up richer fixtures as needed.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
global.HTMLButtonElement = dom.window.HTMLButtonElement;

// Minimal DOM elements that review-gate.js references on load
document.body.innerHTML = `
  <span id="review-list"></span>
  <span id="review-count"></span>
  <span id="review-count-small"></span>
  <div id="branch-tags"></div>
  <input id="branch-input" />
`;

// Mock window.alert
window.alert = jest.fn();

// Mock socket.io
window.io = jest.fn(() => ({
  on: jest.fn(),
  disconnect: jest.fn(),
}));

// Mock Electron preload bridge
window.aigov = {
  onStatusUpdate: jest.fn(),
  startEngine: jest.fn(),
  stopEngine: jest.fn(),
  restartEngine: jest.fn(),
  getStatus: jest.fn(),
  openLogs: jest.fn(),
  retryConnection: jest.fn(),
  platform: 'test',
  arch: 'x64',
};

// Suppress DOMContentLoaded handler — we don't want renderBranches/renderReviewList
// to fire on load since the test fixtures aren't set up yet
const originalAddEventListener = document.addEventListener.bind(document);
document.addEventListener = (event, handler) => {
  if (event === 'DOMContentLoaded') return; // skip
  originalAddEventListener(event, handler);
};

// Load the actual review-gate.js — all its functions become globals
require('../review-gate.js');

// Restore addEventListener so tests can use it
document.addEventListener = originalAddEventListener;
