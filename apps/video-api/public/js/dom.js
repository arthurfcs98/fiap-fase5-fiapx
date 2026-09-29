/* global document, window */
/*
 * Tiny DOM helpers. Every piece of API data reaches the page through `textContent` or an
 * attribute set with `setAttribute` (never innerHTML), and nothing uses inline styles, so the
 * page works under a strict CSP (`default-src 'self'; script-src 'self'`, no 'unsafe-inline').
 */

/** `document.getElementById` that fails loudly when the markup and the script drift apart. */
export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado.`);
  return node;
}

/**
 * Creates an element. `text` goes to textContent; `attrs` values are strings (false/null skip,
 * true sets an empty attribute); `children` may contain nodes, strings or falsy values.
 */
export function el(tag, { className, text, attrs, dataset } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (dataset) {
    for (const [name, value] of Object.entries(dataset)) node.dataset[name] = String(value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof window.Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function show(node, visible = true) {
  node.hidden = !visible;
}

export function hide(node) {
  node.hidden = true;
}

/** Shows `message` in an alert box (or hides it when empty). Optional support id underneath. */
export function setAlert(node, message, { tone = 'error', supportId = null } = {}) {
  node.replaceChildren();
  node.dataset.tone = tone;
  if (!message) {
    node.hidden = true;
    return;
  }
  node.append(el('span', { text: message }));
  if (supportId) {
    node.append(el('span', { className: 'support-id', text: `ID de suporte: ${supportId}` }));
  }
  node.hidden = false;
}

/** Disables a button while an async action runs and swaps its label. Returns a restore fn. */
export function setBusy(button, busyLabel) {
  const label = button.querySelector('.btn-label') ?? button;
  const previous = label.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (busyLabel) label.textContent = busyLabel;
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    label.textContent = previous;
  };
}

const TOAST_TTL_MS = 6000;

/** Non-blocking notification in the live region (#toasts). */
export function toast(message, { tone = 'info', ttlMs = TOAST_TTL_MS } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const close = el('button', {
    className: 'toast-close',
    text: '×',
    attrs: { type: 'button', 'aria-label': 'Fechar aviso' },
  });
  const item = el('div', { className: 'toast', dataset: { tone } }, [
    el('span', { className: 'toast-text', text: message }),
    close,
  ]);
  const remove = () => item.remove();
  close.addEventListener('click', remove);
  region.append(item);
  window.setTimeout(remove, ttlMs);
}

/**
 * Saves a Blob as a file. The object URL is revoked after the click so the page does not keep
 * the data in memory; `download` keeps the browser on the page.
 */
export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { attrs: { href: url, download: fileName, hidden: true } });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Follows a same-origin download link (the signed /api/downloads URL). The empty `download`
 * attribute keeps the page in place and lets Content-Disposition name the file.
 */
export function followDownload(url) {
  const anchor = el('a', { attrs: { href: url, download: '', hidden: true, rel: 'noopener' } });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
