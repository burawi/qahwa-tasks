type InputTrace = { event: string; length: number; connected: boolean; focused: boolean; cancelled: boolean; inputType?: string; composing?: boolean };

/** Temporary, content-free tracing for the Android composer incident. */
export function observeComposerInput(element: HTMLTextAreaElement, report: (message: string) => void): () => void {
  const trace: InputTrace[] = [];
  let reports = 0;
  let timer: number | undefined;
  let frame: number | undefined;
  const flush = () => {
    timer = undefined;
    if (reports >= 12 || trace.length === 0) return;
    reports += 1;
    report(JSON.stringify({ version: 17, disabled: element.disabled, readOnly: element.readOnly, active: document.activeElement?.tagName, trace: trace.splice(0) }));
  };
  const record = (event: Event) => {
    if (reports >= 12) return;
    const input = event as InputEvent;
    const entry: InputTrace = { event: event.type, length: element.value.length, connected: element.isConnected, focused: document.activeElement === element, cancelled: event.defaultPrevented };
    if (input.inputType) entry.inputType = input.inputType;
    if (typeof input.isComposing === 'boolean') entry.composing = input.isComposing;
    trace.push(entry);
    if (trace.length > 16) trace.shift();
    queueMicrotask(() => { entry.cancelled = event.defaultPrevented; });
    if (event.type === 'input') {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        trace.push({ event: 'settled', length: element.value.length, connected: element.isConnected, focused: document.activeElement === element, cancelled: false });
      });
    }
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(flush, 1200);
  };
  const events = ['focus', 'blur', 'keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend'];
  for (const type of events) element.addEventListener(type, record);
  return () => {
    for (const type of events) element.removeEventListener(type, record);
    if (timer !== undefined) window.clearTimeout(timer);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    if (trace.length) { trace.push({ event: 'unmount', length: element.value.length, connected: element.isConnected, focused: document.activeElement === element, cancelled: false }); flush(); }
  };
}
