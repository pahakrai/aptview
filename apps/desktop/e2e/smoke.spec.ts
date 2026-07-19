/**
 * smoke.spec.ts — E2E degradation test for the desktop app.
 *
 * Launches the Electron app WITHOUT a running backend.
 * Verifies the app degrades gracefully — renders UI, shows
 * disconnected message, doesn't crash.
 *
 * Run: npx playwright test --config=e2e/playwright.config.ts
 */

import { _electron as electron } from '@playwright/test';
import { test, expect } from '@playwright/test';

test.describe('Desktop app — degradation smoke', () => {
  let electronApp;
  let page;

  test.beforeAll(async () => {
    // Launch Electron pointed at this directory (apps/desktop)
    electronApp = await electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      executablePath: require('electron'), // resolves from node_modules
    });

    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  // =========================================================================
  // Core UI renders even without backend
  // =========================================================================

  test('renders status bar', async () => {
    await expect(page.locator('#status-bar')).toBeVisible();
  });

  test('renders decision gate buttons', async () => {
    await expect(page.locator('#btn-approve')).toBeVisible();
    await expect(page.locator('#btn-cancel')).toBeVisible();
  });

  test('renders review and diff panes', async () => {
    await expect(page.locator('#review-content')).toBeVisible();
    await expect(page.locator('#diff-content')).toBeVisible();
  });

  test('renders score bar', async () => {
    await expect(page.locator('#score-bar')).toBeVisible();
  });

  // =========================================================================
  // Disconnected state
  // =========================================================================

  test('shows disconnected message when backend is not running', async () => {
    // The app polls localhost:3000/health. With no backend, it should
    // eventually show the error state.
    await expect(page.locator('#status-text')).toContainText(
      /Backend not ready/,
      { timeout: 10000 },
    );
  });

  test('shows retry button in disconnected state', async () => {
    await expect(page.locator('#btn-retry')).toBeVisible();
  });

  test('status dot is red when disconnected', async () => {
    const dot = page.locator('#status-dot');
    // The dot gets classList.add('red') on error state
    await expect(dot).toHaveClass(/red/, { timeout: 10000 });
  });

  // =========================================================================
  // Buttons are disabled when no review is selected
  // =========================================================================

  test('approve button is disabled when no review is active', async () => {
    await expect(page.locator('#btn-approve')).toBeDisabled();
  });

  test('cancel button is disabled when no review is active', async () => {
    await expect(page.locator('#btn-cancel')).toBeDisabled();
  });

  // =========================================================================
  // Reviewer controls are hidden
  // =========================================================================

  test('reviewer controls panel is hidden', async () => {
    await expect(page.locator('#reviewer-controls')).not.toHaveClass(/visible/);
  });

  // =========================================================================
  // Settings overlay opens and closes (no backend needed)
  // =========================================================================

  test('settings overlay opens', async () => {
    // Click the gear icon button in the status bar
    await page.click('button[onclick="toggleSettings()"]');
    await expect(page.locator('#settings-overlay')).toHaveClass(/open/);
  });

  test('settings overlay closes', async () => {
    // Already open from previous test
    await page.click('#settings-overlay button:has-text("Close")');
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/open/);
  });
});
