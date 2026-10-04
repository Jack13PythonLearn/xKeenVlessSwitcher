const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

function fixture() {
  const handlers = {};
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => nodes.get(id),
    addEventListener: (name, fn) => { handlers[name] = fn; } };
  function node(id, parent, options = {}) {
    const el = { id, parent, tabIndex: 0, isConnected: true, disabled: false,
      getClientRects: () => options.hidden ? [] : [{}], closest: () => null,
      focus() { document.activeElement = this; }, ...options };
    nodes.set(id, el);
    return el;
  }
  function modal(id) {
    const el = node(id, null, { classList: { add() {}, remove() {} },
      setAttribute() {}, querySelector: () => null,
      querySelectorAll: () => [...nodes.values()].filter(n => n.parent === el),
      contains: n => n === el || n?.parent === el });
    return el;
  }
  const opener = node('opener'); opener.focus();
  const dialog = modal('dialog');
  const first = node('first', dialog);
  node('hidden', dialog, { hidden: true });
  node('disabled', dialog, { disabled: true });
  const last = node('last', dialog);
  const context = { document, window: { addEventListener: (name, fn) => { handlers[name] = fn; } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const modalStack'), source.indexOf('// TOAST NOTIFICATIONS')), context);
  function key(key, shiftKey = false) {
    const e = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    handlers.keydown(e); return e;
  }
  return { context, document, handlers, opener, dialog, first, last, modal, node, key };
}

test('modal wraps Tab in both directions, excluding hidden and disabled controls', () => {
  const f = fixture(); f.context.openModal('dialog');
  assert.equal(f.document.activeElement, f.first);
  f.last.focus(); assert.equal(f.key('Tab').prevented, true);
  assert.equal(f.document.activeElement, f.first);
  assert.equal(f.key('Tab', true).prevented, true);
  assert.equal(f.document.activeElement, f.last);
  f.first.focus(); assert.equal(f.key('Tab').prevented, false);
  f.opener.focus(); f.handlers.focusin({ target: f.opener });
  assert.equal(f.document.activeElement, f.first);
});

test('Escape closes only the top dialog and returns focus through nested dialogs', () => {
  const f = fixture(); f.context.openModal('dialog');
  const nested = f.modal('nested'); f.node('nested-first', nested);
  f.last.focus(); f.context.openModal('nested');
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(f.document.activeElement, f.last);
  f.key('Escape'); assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.key('Tab').prevented, false);
});

test('backdrop close restores the opener and empty dialog keeps keyboard focus', () => {
  const f = fixture();
  const empty = f.modal('empty');
  empty.classList.contains = value => value === 'modal-overlay';
  f.context.openModal('empty');
  assert.equal(f.document.activeElement, empty);
  assert.equal(f.key('Tab').prevented, true);
  assert.equal(f.document.activeElement, empty);
  f.handlers.click({ target: empty });
  assert.equal(f.document.activeElement, f.opener);
});
