import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from 'terminal-app';
import { api, connection } from 'terminal-api';
import { Terminal } from 'terminal-emulator';
import 'terminal-styles';

const fixture = window.terminalFixture = { api, connection, lostCreate: false, lostInput: false, delayCreate: 0, screenResets: 0, screenSizes: [], terminalReads: [], sizeRequests: [], emulator: null };
fixture.touchEvents = [];
fixture.replayNextRead = false;
fixture.delayNextWrite = 0;
fixture.delayedWritePending = false;
fixture.inputCalls = 0;
for (const type of ['touchstart', 'touchmove', 'touchend', 'wheel']) window.addEventListener(type, event => {
  fixture.touchEvents.push({ type, target: event.target?.className, delta: event.deltaY, y: event.touches?.[0]?.clientY });
}, { capture: true, passive: true });
const reset = Terminal.prototype.reset;
Terminal.prototype.reset = function (...args) {
  fixture.emulator = this;
  fixture.screenResets++;
  return reset.apply(this, args);
};
const resize = Terminal.prototype.resize;
Terminal.prototype.resize = function (...args) {
  fixture.screenSizes.push(args);
  return resize.apply(this, args);
};
const write = Terminal.prototype.write;
Terminal.prototype.write = function (data, callback) {
  if (fixture.delayNextWrite) {
    const delay = fixture.delayNextWrite; fixture.delayNextWrite = 0; fixture.delayedWritePending = true;
    setTimeout(() => write.call(this, data, () => { fixture.delayedWritePending = false; callback?.(); }), delay);
    return;
  }
  return write.call(this, data, callback);
};
const terminal = api.terminal;
api.terminal = async (...args) => {
  let result = await terminal(...args);
  if (fixture.replayNextRead) { fixture.replayNextRead = false; result = await terminal(args[0]); }
  const { reset, cursor, cols, rows, state } = result.terminal;
  fixture.terminalReads.push({ args, reset, cursor, cols, rows, state });
  return result;
};
const size = api.resizeTerminal;
api.resizeTerminal = async (...args) => {
  fixture.sizeRequests.push(args);
  return size(...args);
};
const create = api.createTerminal;
api.createTerminal = async (...args) => {
  if (fixture.delayCreate) await new Promise(resolve => setTimeout(resolve, fixture.delayCreate));
  const result = await create(...args);
  if (fixture.lostCreate) { fixture.lostCreate = false; throw new Error('Simulated lost creation response'); }
  return result;
};
const input = api.terminalInput;
api.terminalInput = async (...args) => {
  fixture.inputCalls++;
  const result = await input(...args);
  if (fixture.lostInput && args[3].includes('\r')) { fixture.lostInput = false; throw new Error('Simulated lost input response'); }
  return result;
};
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
