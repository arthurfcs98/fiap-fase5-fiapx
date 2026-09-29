/* global document, window */
/*
 * Entry point (loaded as an ES module, no build step). Owns the session lifecycle and the
 * hash routes:
 *   #/entrar · #/cadastro        signed out
 *   #/videos · #/meus-dados      signed in
 * The JWT lives in sessionStorage (tab scoped); a 401 on any authenticated call, or the token
 * reaching its `exp`, signs the user out with an explanation.
 */
import { AccountPanel } from './account.js';
import { api, onUnauthorized } from './api.js';
import { AuthPanel } from './auth.js';
import { byId, toast } from './dom.js';
import { DEFAULT_MAX_UPLOAD_MB, initials } from './format.js';
import { clearSession, isExpired, loadSession, saveSession } from './session.js';
import { UploadQueue } from './uploads.js';
import { VideosPanel } from './videos.js';

const ROUTES = Object.freeze({
  '#/entrar': 'login',
  '#/cadastro': 'register',
  '#/videos': 'videos',
  '#/meus-dados': 'account',
});
const HASH_BY_ROUTE = Object.freeze({
  login: '#/entrar',
  register: '#/cadastro',
  videos: '#/videos',
  account: '#/meus-dados',
});
const TITLES = Object.freeze({
  login: 'Entrar',
  register: 'Criar conta',
  videos: 'Seus vídeos',
  account: 'Meus dados',
});
/** setTimeout cannot wait longer than 2^31-1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

const notify = (message, tone = 'info') => toast(message, { tone });

const state = { session: null, expiryTimer: null, route: null, loggingOut: false };

const views = {
  boot: byId('view-boot'),
  auth: byId('view-auth'),
  videos: byId('view-videos'),
  account: byId('view-account'),
};
const nav = byId('app-nav');
const userArea = byId('user-area');
const userName = byId('user-name');
const userInitials = byId('user-initials');
const main = byId('main');

function getToken() {
  const { session } = state;
  return session && !isExpired(session) ? session.token : null;
}

const auth = new AuthPanel({ onAuthenticated: (session) => signIn(session) });
const videos = new VideosPanel({ getToken, notify });
const account = new AccountPanel({
  getToken,
  notify,
  onDeleted: () =>
    signOut(
      'Sua conta foi excluída. Seus vídeos, arquivos .zip e histórico foram apagados.',
      'success',
    ),
});
const uploads = new UploadQueue({
  list: byId('upload-list'),
  panel: byId('upload-panel'),
  summary: byId('upload-summary'),
  startButton: byId('upload-start'),
  clearButton: byId('upload-clear'),
  getToken,
  notify,
  onAccepted: () => videos.refreshNow(),
});

// ---- routing ------------------------------------------------------------------------------

function routeFromHash() {
  return Object.hasOwn(ROUTES, window.location.hash) ? ROUTES[window.location.hash] : null;
}

/** Rewrites the hash without adding a history entry (and without firing hashchange). */
function replaceRoute(route) {
  if (window.location.hash !== HASH_BY_ROUTE[route]) {
    window.history.replaceState(null, '', HASH_BY_ROUTE[route]);
  }
}

function showView(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
}

function render({ moveFocus = false } = {}) {
  const requested = routeFromHash();
  const signedIn = Boolean(getToken());
  let route;
  if (signedIn) {
    route = requested === 'account' ? 'account' : 'videos';
  } else {
    route = requested === 'register' ? 'register' : 'login';
  }
  replaceRoute(route);
  const changed = route !== state.route;
  state.route = route;

  nav.hidden = !signedIn;
  userArea.hidden = !signedIn;
  for (const link of nav.querySelectorAll('[data-route]')) {
    const current = HASH_BY_ROUTE[route] === link.getAttribute('href');
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  if (signedIn) {
    showView(route);
    if (route === 'videos') videos.start();
    else videos.stop();
  } else {
    videos.stop();
    showView('auth');
    auth.select(route);
  }
  document.title = `${TITLES[route]} · FIAP Frames`;
  // Arrow keys on the Entrar/Criar conta tabs keep the focus on the tab (ARIA tabs pattern).
  const onTab = document.activeElement?.getAttribute('role') === 'tab';
  if (moveFocus && changed && !onTab) {
    if (signedIn) main.focus({ preventScroll: true });
    else auth.focusFirstField(route);
    window.scrollTo({ top: 0 });
  }
}

window.addEventListener('hashchange', () => render({ moveFocus: true }));

// ---- session ------------------------------------------------------------------------------

function applyUser(user) {
  const name = user?.name || user?.email || 'Minha conta';
  userName.textContent = name;
  userInitials.textContent = initials(user?.name || user?.email || '?');
  account.showUser(user);
}

function scheduleExpiry() {
  window.clearTimeout(state.expiryTimer);
  const { session } = state;
  if (!session) return;
  const delay = Math.min(MAX_TIMER_MS, Math.max(0, session.expiresAt - Date.now() - 5000));
  state.expiryTimer = window.setTimeout(
    () => signOut('Sua sessão expirou. Entre novamente para continuar.', 'warn'),
    delay,
  );
}

/** Loads /api/auth/me for the header; a non-401 failure keeps the (valid) session anyway. */
async function fetchUser(token) {
  try {
    const user = await api.me(token);
    return { id: user?.id ?? null, name: user?.name ?? '', email: user?.email ?? '' };
  } catch (error) {
    if (error?.status === 401) throw error;
    notify('Não foi possível carregar seu perfil agora. Tente atualizar a página.', 'warn');
    return null;
  }
}

async function signIn(session) {
  const user = await fetchUser(session.token);
  state.session = saveSession({ ...session, user });
  applyUser(user);
  scheduleExpiry();
  auth.setNotice('');
  window.history.replaceState(null, '', HASH_BY_ROUTE.videos);
  render({ moveFocus: true });
}

function signOut(message = '', tone = 'info') {
  if (state.loggingOut) return;
  state.loggingOut = true;
  try {
    window.clearTimeout(state.expiryTimer);
    state.session = null;
    clearSession();
    uploads.abortAll();
    videos.reset();
    account.reset();
    auth.reset();
    applyUser(null);
    auth.setNotice(message, tone);
    window.history.replaceState(null, '', HASH_BY_ROUTE.login);
    render({ moveFocus: true });
  } finally {
    state.loggingOut = false;
  }
}

onUnauthorized(() => {
  if (state.session) signOut('Sua sessão expirou ou foi encerrada. Entre novamente.', 'warn');
});

byId('logout-button').addEventListener('click', () => {
  if (
    uploads.busy &&
    !window.confirm('Há envios em andamento. Se você sair agora, eles serão cancelados. Sair?')
  ) {
    return;
  }
  signOut('Você saiu da sua conta.', 'info');
});

window.addEventListener('beforeunload', (event) => {
  if (!uploads.busy) return;
  event.preventDefault();
  event.returnValue = '';
});

// ---- file picking (input + drag and drop) ------------------------------------------------

const dropzone = byId('dropzone');
const fileInput = byId('file-input');
byId('max-upload-mb').textContent = String(DEFAULT_MAX_UPLOAD_MB);

fileInput.addEventListener('change', () => {
  uploads.add(fileInput.files);
  fileInput.value = ''; // picking the same file again must fire "change"
});

const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('is-dragging');
  });
}
dropzone.addEventListener('dragleave', (event) => {
  if (!dropzone.contains(event.relatedTarget)) dropzone.classList.remove('is-dragging');
});
dropzone.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dropzone.classList.remove('is-dragging');
  uploads.add(event.dataTransfer.files);
});
// A file dropped outside the drop zone must not make the browser leave the page.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (hasFiles(event) && !dropzone.contains(event.target)) event.preventDefault();
  });
}

// ---- boot -----------------------------------------------------------------------------------

async function boot() {
  const stored = loadSession();
  if (stored) {
    try {
      const user = await fetchUser(stored.token);
      state.session = saveSession({ ...stored, user });
      applyUser(user);
      scheduleExpiry();
    } catch {
      // 401: token revoked (account deleted elsewhere) or signed with an old secret.
      state.session = null;
      clearSession();
      auth.setNotice('Sua sessão expirou. Entre novamente.', 'warn');
    }
  }
  render();
}

void boot();
