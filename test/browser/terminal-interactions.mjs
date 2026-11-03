import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function verifyTerminalInteractions({ browser, origin, pair, directory, project, until }) {
  await writeFile(join(project.rootDirectory, 'keys.py'), `import os, sys, termios, tty
fd = sys.stdin.fileno()
previous = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    os.write(1, b'\\r\\nRAW_KEYS_READY\\r\\n')
    counts = {}
    while True:
        data = os.read(fd, 4096)
        counts[data] = counts.get(data, 0) + 1
        os.write(1, b'\\r\\nKEY:' + data.hex().encode() + b':' + str(counts[data]).encode() + b'\\r\\n')
        if data == b'q':
            break
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, previous)
print('RAW_KEYS_EXITED')
`);
  const results = [];
  for (const [touch, width, height, theme] of [[true, 390, 740, 'light'], [true, 390, 420, 'dark'], [false, 1280, 900, 'light'], [false, 1280, 900, 'dark']]) {
    if (process.env.TERMINAL_FOCUS_ONLY && (!touch || height !== 740)) continue;
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme,
      hasTouch: touch, isMobile: touch, ...(touch ? { userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36' } : {}) });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.evaluate(uri => terminalFixture.connection.pair(uri), pair());
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Project', { exact: true }).selectOption(project.id);
    await modal.getByRole('button', { name: 'Open terminal chat' }).click();
    const keyboard = page.getByRole('textbox', { name: 'Interactive terminal', exact: true });
    assert.equal(await page.getByRole('textbox', { name: 'Message terminal', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Send to terminal', exact: true }).count(), 0);
    await until(() => keyboard.isEditable(), 'Terminal becomes interactive');
    const tap = async name => {
      const button = page.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button[touch ? 'tap' : 'click']();
    };
    const send = async text => { await keyboard.focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
    const content = () => page.locator('.terminal-screen .xterm-screen').innerText();
    await send('for i in $(seq 1 180); do printf "SCROLL_LINE_%03d\\n" "$i"; done');
    await until(async () => (await content()).includes('SCROLL_LINE_180'), 'Long output is rendered');
    const position = () => page.evaluate(() => ({ top: terminalFixture.emulator.buffer.active.viewportY, bottom: terminalFixture.emulator.buffer.active.baseY }));
    const before = await position(); assert.ok(before.bottom > 100);
    const box = await page.locator('.terminal-screen .xterm-screen').boundingBox();
    const x = box.x + box.width / 2;
    const swipe = async (down, target = box) => {
      const session = await page.context().newCDPSession(page);
      const inset = Math.min(40, target.height / 5), swipeX = target.x + target.width / 2;
      const start = target.y + (down ? inset : target.height - inset), end = target.y + (down ? target.height - inset : inset);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: swipeX, y: start }] });
      for (let i = 1; i <= 8; i++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipeX, y: start + (end - start) * i / 8 }] });
        await page.waitForTimeout(25);
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    };
    if (touch) await swipe(true);
    else { await page.mouse.move(x, box.y + box.height / 2); await page.mouse.wheel(0, -400); }
    await writeFile(join(directory, `scroll-debug-${touch}.json`), JSON.stringify(await page.evaluate(() => ({ events: terminalFixture.touchEvents, top: terminalFixture.emulator.buffer.active.viewportY, bottom: terminalFixture.emulator.buffer.active.baseY })), null, 2));
    await until(async () => (await position()).top < before.top, 'Scrolling up reaches terminal history');
    const older = await position();
    if (touch) await swipe(false); else await page.mouse.wheel(0, 400);
    await until(async () => (await position()).top > older.top, 'Scrolling down returns toward the prompt');
    await tap('Select terminal text');
    const history = page.getByLabel('Selectable terminal history', { exact: true });
    await history.waitFor();
    assert.ok((await history.textContent()).includes('SCROLL_LINE_001'));
    assert.equal(await history.evaluate(node => getComputedStyle(node).userSelect), 'text');
    const historyBottom = await history.evaluate(node => node.scrollTop);
    if (touch) {
      const historyBox = await history.boundingBox();
      await swipe(true, historyBox);
      await until(async () => await history.evaluate(node => node.scrollTop) < historyBottom, 'Selectable text scrolls up with native touch');
      const top = await history.evaluate(node => node.scrollTop);
      await swipe(false, historyBox);
      await until(async () => await history.evaluate(node => node.scrollTop) > top, 'Selectable text scrolls down with native touch');
    }
    await history.evaluate(node => { node.scrollTop = node.scrollHeight; });
    if (!touch) {
      const rect = await history.evaluate(node => {
        const start = node.firstChild.textContent.indexOf('SCROLL_LINE_180');
        const range = document.createRange(); range.setStart(node.firstChild, start); range.setEnd(node.firstChild, start + 15);
        const box = range.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height };
      });
      await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down();
      await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, { steps: 10 }); await page.mouse.up();
      assert.ok((await page.evaluate(() => getSelection().toString())).includes('SCROLL'), 'Dragging selects actual rendered terminal text');
    }
    // Native selection inside the ordinary text view can be copied without
    // relying on xterm's mouse-only selection layer.
    await history.evaluate(node => {
      const start = node.firstChild.textContent.indexOf('SCROLL_LINE_180');
      const range = document.createRange(); range.setStart(node.firstChild, start); range.setEnd(node.firstChild, start + 15);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await tap('Copy terminal text');
    await until(async () => await page.evaluate(() => navigator.clipboard.readText()) === 'SCROLL_LINE_180', 'Copy preserves the selected portion');
    const selectionBefore = await page.evaluate(() => getSelection().toString());
    await page.evaluate(async () => {
      const view = terminalFixture.terminalReads.at(-1);
      await terminalFixture.api.terminalInput(view.args[0], view.args[1], crypto.randomUUID(), "printf 'NEW_OUTPUT_WHILE_SELECTING\\n'\r");
    });
    await until(async () => (await content()).includes('NEW_OUTPUT_WHILE_SELECTING'), 'Shell output continues behind text selection');
    assert.equal(await page.evaluate(() => getSelection().toString()), selectionBefore, 'Streaming output does not destroy native selection');
    assert.ok(!(await history.textContent()).includes('NEW_OUTPUT_WHILE_SELECTING'), 'Selection snapshot stays stable');
    await tap('Back to live terminal');
    if (touch) {
      const inherited = await page.locator('.terminal-screen').evaluate(node => node.inert);
      assert.equal(inherited, false, 'Returning to live mode restores terminal interaction');
    }
    await send('python3 keys.py');
    await until(async () => (await content()).includes('RAW_KEYS_READY'), 'Raw PTY fixture starts');
    if (touch) {
      // Chromium emulation has no OS keyboard. Model its focus-driven visual
      // viewport resize so a button stealing focus can move before click.
      await page.evaluate(fullHeight => {
        const viewport = window.visualViewport;
        let open = false;
        terminalFixture.keyboardViewportEvents = [];
        Object.defineProperty(viewport, 'height', { configurable: true, get: () => open ? Math.min(400, fullHeight - 100) : fullHeight });
        const update = focused => {
          const next = focused instanceof HTMLTextAreaElement;
          if (next === open) return;
          open = next;
          terminalFixture.keyboardViewportEvents.push({ open, target: focused?.getAttribute?.('aria-label') || focused?.tagName });
          viewport.dispatchEvent(new Event('resize'));
        };
        const focusIn = event => update(event.target), focusOut = event => update(event.relatedTarget);
        document.addEventListener('focusin', focusIn); document.addEventListener('focusout', focusOut);
        update(document.activeElement);
        terminalFixture.restoreKeyboardViewport = () => {
          document.removeEventListener('focusin', focusIn); document.removeEventListener('focusout', focusOut);
          delete viewport.height; viewport.dispatchEvent(new Event('resize'));
        };
      }, height);
      await keyboard.focus();
      await until(() => page.evaluate(() => window.visualViewport.height < window.innerHeight), 'Keyboard-open viewport is simulated');
      const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true });
      await tap('Ctrl');
      await writeFile(join(directory, `keyboard-focus-${height}.json`), JSON.stringify(await page.evaluate(() => ({ events: terminalFixture.keyboardViewportEvents, control: document.querySelector('.terminal-keys button')?.getAttribute('aria-pressed'), focused: document.activeElement?.getAttribute('aria-label'), disableStdin: terminalFixture.emulator.options.disableStdin })), null, 2));
      assert.equal(await ctrl.getAttribute('aria-pressed'), 'true', 'Tapping Ctrl while the keyboard is open must activate it');
      await page.keyboard.press('a');
      await until(async () => (await content()).includes('KEY:01'), 'Keyboard-open control reaches the PTY');
      await keyboard.focus();
      const tab = page.getByRole('button', { name: 'Tab', exact: true });
      await tab.scrollIntoViewIfNeeded();
      const tabBox = await tab.boundingBox(), normalBackground = await tab.evaluate(node => getComputedStyle(node).backgroundColor);
      const pointer = await page.context().newCDPSession(page);
      await pointer.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 }] });
      await page.waitForTimeout(100);
      const pressedBackground = await tab.evaluate(node => getComputedStyle(node).backgroundColor);
      await page.screenshot({ path: join(directory, `keyboard-button-held-${height}.png`) });
      assert.notEqual(pressedBackground, normalBackground, 'A held terminal button has visible press feedback');
      await pointer.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pointer.detach();
      await until(async () => (await content()).includes('KEY:09'), 'Keyboard-open Tab reaches the PTY');
      await page.keyboard.type('b');
      await tap('Enter');
      await until(async () => (await content()).includes('KEY:62') && (await content()).includes('KEY:0d'), 'Direct typing and Enter work with the keyboard open');
      assert.equal(await keyboard.evaluate(node => document.activeElement === node), true, 'Controls keep the terminal keyboard focused');
      assert.equal(await page.evaluate(() => terminalFixture.keyboardViewportEvents.some(event => !event.open)), false,
        'Terminal controls never move focus through a button and close the keyboard');
      const toolbar = page.getByRole('toolbar', { name: 'Terminal keys' });
      // Enter is now on the same bar as the other keys. Tapping it scrolls the
      // bar to its right edge; start the pan check with room left to scroll.
      await toolbar.evaluate(node => { node.scrollLeft = 0; });
      const bar = await toolbar.boundingBox(), beforePan = await page.evaluate(() => terminalFixture.inputCalls);
      const beforePanLeft = await toolbar.evaluate(node => node.scrollLeft);
      const pan = await page.context().newCDPSession(page);
      await pan.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bar.x + bar.width - 25, y: bar.y + bar.height / 2 }] });
      for (let i = 1; i <= 8; i++) {
        await pan.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bar.x + bar.width - 25 - 25 * i, y: bar.y + bar.height / 2 }] });
        await page.waitForTimeout(20);
      }
      await pan.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pan.detach();
      await until(async () => await toolbar.evaluate(node => node.scrollLeft) > beforePanLeft, 'Controls still scroll horizontally with the keyboard open');
      assert.equal(await page.evaluate(() => terminalFixture.inputCalls), beforePan, 'A toolbar swipe does not accidentally press a control');
      await page.evaluate(() => terminalFixture.restoreKeyboardViewport());
      await ctrl.focus(); await page.keyboard.press('Space');
      assert.equal(await ctrl.getAttribute('aria-pressed'), 'true', 'Controls remain keyboard accessible');
      await tap('Ctrl');
    }
    if (process.env.TERMINAL_FOCUS_ONLY) {
      results.push({ touch, keyboardOpenControls: true }); await page.close(); continue;
    }
    for (const [name, hex] of [['Ctrl+C', '03'], ['Ctrl+D', '04'], ['Ctrl+Z', '1a'], ['Esc', '1b'], ['Tab', '09'], ['Arrow up', '1b5b41'], ['Arrow down', '1b5b42'], ['Arrow left', '1b5b44'], ['Arrow right', '1b5b43'], ['Enter', '0d']]) {
      await tap(name);
      await until(async () => (await content()).includes(`KEY:${hex}`), `${name} sends its exact control sequence to the PTY`);
    }
    await tap('Ctrl');
    await page.keyboard.press('a');
    await until(async () => (await content()).includes('KEY:01'), 'Ctrl modifier applies to the next terminal key');
    assert.equal(await page.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed'), 'false');
    // A slow full-screen replay previously discarded toolbar input silently.
    await page.evaluate(async () => {
      terminalFixture.replayNextRead = true; terminalFixture.delayNextWrite = 1200;
      const view = terminalFixture.terminalReads.at(-1);
      await terminalFixture.api.terminalInput(view.args[0], view.args[1], crypto.randomUUID(), 'x');
    });
    await until(() => page.evaluate(() => terminalFixture.delayedWritePending), 'Slow snapshot replay begins');
    await tap('Esc');
    await until(() => page.evaluate(() => !terminalFixture.delayedWritePending), 'Snapshot replay completes');
    await until(async () => (await content()).includes('KEY:1b:2'), 'Toolbar input during replay is delivered');
    await page.evaluate(async () => {
      terminalFixture.replayNextRead = true; terminalFixture.delayNextWrite = 1200;
      const view = terminalFixture.terminalReads.at(-1);
      await terminalFixture.api.terminalInput(view.args[0], view.args[1], crypto.randomUUID(), 'x');
    });
    await until(() => page.evaluate(() => terminalFixture.delayedWritePending), 'Second slow snapshot replay begins');
    await page.keyboard.type('y');
    await until(() => page.evaluate(() => !terminalFixture.delayedWritePending), 'Second snapshot replay completes');
    await until(async () => (await content()).includes('KEY:79:1'), 'Typing during replay is also delivered');
    await tap('Focus terminal keyboard');
    await page.keyboard.type('q');
    await until(async () => (await content()).includes('RAW_KEYS_EXITED'), 'Raw program exits via the focused terminal keyboard');
    await keyboard.focus();
    await page.keyboard.type("printf 'ENTER_BUTTON_WORKS\\n'");
    await tap('Enter');
    await until(async () => (await content()).includes('ENTER_BUTTON_WORKS'), 'Enter executes the line typed directly in the shell');
    await send('python3 fullscreen.py');
    await until(async () => (await content()).includes('CURSES_READY'), 'Fullscreen program starts');
    if (touch) await swipe(true); else await tap('Arrow up');
    await until(async () => (await content()).includes('ARROW_OK'), 'Touch swipe or toolbar arrow reaches a fullscreen application');
    await tap('Focus terminal keyboard'); await page.keyboard.type('q');
    await until(async () => (await content()).includes('CURSES_EXITED'), 'Fullscreen program exits');
    await send('sleep 60');
    await tap('Ctrl+C');
    await send("printf 'SIGNAL_WORKS\\n'");
    await until(async () => (await content()).includes('SIGNAL_WORKS'), 'Ctrl+C interrupts a running program');
    await page.screenshot({ path: join(directory, `terminal-interactions-${width}-${height}-${theme}.png`) });
    await tap('Ctrl+D');
    await page.getByRole('button', { name: 'Start new shell' }).waitFor();
    assert.deepEqual(errors, []);
    await tap('Select terminal text');
    await history.waitFor();
    assert.ok((await history.textContent()).includes('SCROLL_LINE_001'), 'History remains selectable after shell exit');
    await page.screenshot({ path: join(directory, `terminal-selection-${width}-${height}-${theme}.png`) });
    results.push({ touch, width, height, theme, scrolling: true, selectionAndCopy: true, stableSelection: true, allControls: true, directInputOnly: true, replayInput: true, replayTyping: true, keyboardViewportSimulated: touch, keyboardOpenControls: touch, pressedFeedback: touch, fullscreenSwipe: touch, interruptAndEof: true });
    await page.close();
  }
  return results;
}
