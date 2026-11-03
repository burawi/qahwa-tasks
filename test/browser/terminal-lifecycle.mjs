import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyTerminalLifecycle({ browser, origin, pair, directory, project, until, tasks, database }) {
  const results = [];
  for (const [width, height, theme] of [[1280, 900, 'light'], [390, 844, 'dark'], [320, 420, 'light'], [844, 390, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 600, isMobile: width < 600, colorScheme: theme });
    const page = await context.newPage(), errors = [];
    const press = button => button[width < 600 ? 'tap' : 'click']();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.evaluate(uri => terminalFixture.connection.pair(uri), pair());
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Project', { exact: true }).selectOption(project.id);
    await page.getByRole('button', { name: 'Open terminal chat' }).click();
    const keyboard = page.getByRole('textbox', { name: 'Interactive terminal', exact: true });
    await until(() => keyboard.isEditable(), 'Shell is interactive');
    const layout = () => page.locator('.terminal-session').evaluate(node => {
      const header = node.querySelector('.session-header'), box = header.getBoundingClientRect();
      const actions = node.querySelector('.terminal-actions');
      const status = node.querySelector('.terminal-session-status');
      const terminal = node.querySelector('.terminal-message'), section = terminal.getBoundingClientRect();
      const screen = node.querySelector('.terminal-screen');
      return { headerHeight: box.height, actionsInHeader: header.contains(actions), statusInSubtitle: Boolean(status.closest('.session-subtitle')),
        status: status.textContent, historyPreserved: header.textContent.includes('History preserved'),
        iconActions: [...actions.querySelectorAll('button')].every(button => {
          const r = button.getBoundingClientRect();
          return !button.textContent.trim() && button.getAttribute('aria-label') && r.width === 44 && r.height === 44
            && r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
        }), terminalLeft: section.left, terminalWidth: section.width, viewportWidth: innerWidth,
        terminalRadius: getComputedStyle(terminal).borderRadius, screenPadding: getComputedStyle(screen).padding,
        headingRemoved: !node.querySelector('.terminal-message-heading'), overflow: node.scrollWidth > innerWidth + 1 };
    });
    const runningLayout = await layout();
    assert.equal(runningLayout.headerHeight, 72, JSON.stringify(runningLayout));
    assert.equal(runningLayout.actionsInHeader, true);
    assert.equal(runningLayout.statusInSubtitle, true);
    assert.equal(runningLayout.status, 'running');
    assert.equal(runningLayout.historyPreserved, false);
    assert.equal(runningLayout.iconActions, true, JSON.stringify(runningLayout));
    assert.equal(runningLayout.terminalLeft, 0);
    assert.equal(runningLayout.terminalWidth, runningLayout.viewportWidth);
    assert.equal(runningLayout.terminalRadius, '0px');
    assert.equal(runningLayout.screenPadding, '14px');
    assert.equal(runningLayout.headingRemoved, true);
    assert.equal(runningLayout.overflow, false);
    const id = new URL(page.url()).pathname.split('/').at(-1);
    const task = tasks.getTask(id);
    const send = async line => { await keyboard.focus(); await page.keyboard.type(line); await page.keyboard.press('Enter'); };
    const screen = () => page.locator('.terminal-screen .xterm-screen').innerText();
    await send("printf 'LIFECYCLE_HISTORY\\n'; sleep 120");
    await until(async () => (await screen()).includes('LIFECYCLE_HISTORY'), 'History appears');
    const stop = page.getByRole('button', { name: 'Stop terminal', exact: true });
    const close = page.getByRole('button', { name: 'Close session', exact: true });
    // Native modal confirmation, safe initial focus, Escape and focus restoration.
    await press(close);
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await close.evaluate(node => node === document.activeElement), true);
    assert.equal(tasks.getTask(id).status, 'backlog');
    // Offline controls never submit, including a dialog opened before offline.
    await press(close);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    assert.equal((await layout()).status, 'Offline');
    await until(() => dialog.getByRole('button', { name: 'Close session', exact: true }).isDisabled(), 'Confirmation pauses offline');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await stop.isDisabled(), true); assert.equal(await close.isDisabled(), true);
    assert.equal(tasks.getTask(id).status, 'backlog');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.evaluate(() => terminalFixture.connection.connect());
    await until(() => stop.isEnabled(), 'Reconnect restores controls');
    // Lose the real server acknowledgement. Retrying must target the same shell.
    await page.evaluate(() => {
      const original = terminalFixture.api.terminalAction;
      terminalFixture.api.terminalAction = async (...args) => {
        const result = await original(...args);
        if (args[2] === 'stop') { terminalFixture.api.terminalAction = original; throw new Error('Simulated lost stop acknowledgement'); }
        return result;
      };
    });
    // Hold a real running-state poll until stop/retry has completed. Its late
    // response must not re-enable input or replace the stopped-state controls.
    await page.evaluate(async () => {
      const original = terminalFixture.api.terminal;
      terminalFixture.api.terminal = async (...args) => {
        terminalFixture.api.terminal = original;
        const result = await original(args[0]);
        terminalFixture.pollHeld = true;
        await new Promise(resolve => { terminalFixture.releaseHeldPoll = resolve; });
        return result;
      };
      const id = location.pathname.split('/').at(-1);
      const { terminal } = await original(id);
      await terminalFixture.api.terminalInput(id, terminal.generation, crypto.randomUUID(), '\x03');
    });
    await until(() => page.evaluate(() => terminalFixture.pollHeld === true), 'Running-state poll is held');
    await press(stop);
    await page.getByRole('button', { name: 'Retry stop', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry stop', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start new shell', exact: true });
    await start.waitFor();
    await until(() => start.isEnabled(), 'Stop completed');
    await page.evaluate(() => terminalFixture.releaseHeldPoll());
    await page.waitForTimeout(150);
    assert.equal(await stop.isDisabled(), true);
    assert.equal(tasks.getTask(id).status, 'backlog');
    await start.click();
    await until(() => keyboard.isEditable(), 'Fresh shell accepts input');
    await send("printf 'FRESH_SHELL_READY\\n'");
    await until(async () => (await screen()).includes('FRESH_SHELL_READY'), 'New shell runs');
    await press(close);
    // Trap keyboard focus within the confirmation at both ends.
    await dialog.getByRole('button', { name: 'Close session', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close dialog', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.screenshot({ path: join(directory, `lifecycle-confirm-${width}-${height}.png`) });
    await page.evaluate(() => {
      const original = terminalFixture.api.terminalAction;
      terminalFixture.api.terminalAction = async (...args) => {
        const result = await original(...args);
        if (args[2] === 'close') { terminalFixture.api.terminalAction = original; throw new Error('Simulated lost close acknowledgement'); }
        return result;
      };
    });
    await dialog.getByRole('button', { name: 'Close session', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(tasks.getTask(id).status, 'closed');
    await dialog.getByRole('button', { name: 'Close session', exact: true }).click();
    const restore = page.getByRole('button', { name: 'Restore session', exact: true });
    await restore.waitFor();
    const closedLayout = await layout();
    assert.equal(closedLayout.headerHeight, runningLayout.headerHeight);
    assert.equal(closedLayout.status, 'Closed');
    assert.equal(closedLayout.statusInSubtitle, true);
    assert.equal(closedLayout.iconActions, true, JSON.stringify(closedLayout));
    assert.equal(closedLayout.historyPreserved, false);
    assert.equal(tasks.getTask(id).status, 'closed');
    assert.equal(await start.count(), 0);
    assert.equal(await keyboard.evaluate(node => node.readOnly), true);
    await page.reload();
    await restore.waitFor();
    await page.getByRole('button', { name: 'Select terminal text', exact: true }).click();
    await until(async () => (await page.getByLabel('Selectable terminal history', { exact: true }).textContent()).includes('LIFECYCLE_HISTORY'), 'Closed history persists after reload');
    await page.getByRole('button', { name: 'Back to live terminal', exact: true }).click();
    await press(restore);
    await start.waitFor();
    assert.equal(tasks.getTask(id).status, 'backlog');
    assert.equal(tasks.getTask(id).projectId, project.id);
    await start.click();
    await until(() => keyboard.isEditable(), 'Restored session starts fresh');
    // Simulate another paired device closing while this viewer is polling.
    await page.evaluate(async () => {
      const id = location.pathname.split('/').at(-1);
      const { terminal } = await terminalFixture.api.terminal(id);
      await terminalFixture.api.terminalAction(id, terminal.generation, 'close');
    });
    await restore.waitFor();
    const geometry = await page.locator('.terminal-session').evaluate(node => {
      const actions = node.querySelector('.terminal-actions').getBoundingClientRect();
      const keys = node.querySelector('.terminal-keys').getBoundingClientRect();
      const screen = node.querySelector('.terminal-screen').getBoundingClientRect();
      return { overflow: node.scrollWidth > innerWidth + 1, actionsVisible: actions.left >= 0 && actions.right <= innerWidth + 1,
        keysVisible: keys.bottom <= innerHeight + 1, screenHeight: screen.height };
    });
    assert.equal(geometry.overflow, false, JSON.stringify(geometry));
    assert.equal(geometry.actionsVisible, true, JSON.stringify(geometry));
    assert.equal(geometry.keysVisible, true, JSON.stringify(geometry));
    assert.ok(geometry.screenHeight > 40, JSON.stringify(geometry));
    assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE owner_id = ?").get(task.id).n, 0);
    await page.screenshot({ path: join(directory, `lifecycle-closed-${width}-${height}.png`) });
    assert.deepEqual(errors, []);
    results.push({ width, height, theme, realEncryptedRpc: true, stop: true, retry: true, closeRetry: true, stalePoll: true, freshStart: true, confirm: true, keyboardFocus: true, offline: true, reconnect: true, close: true, restore: true, historyAfterReload: true, otherDeviceSync: true, geometry, runningLayout, closedLayout });
    await context.close();
  }
  return results;
}
