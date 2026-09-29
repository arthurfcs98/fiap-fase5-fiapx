/* global window */
/*
 * Login and registration forms. Registration requires accepting the privacy policy and sends
 * `acceptPrivacyPolicy: true` (contratos.md, section 12); after a 201 the user is signed in
 * right away with the same credentials.
 */
import { api, userMessage } from './api.js';
import { byId, setAlert, setBusy } from './dom.js';
import { EMAIL_PATTERN, passwordProblem } from './format.js';
import { createSession } from './session.js';

const ROUTE_BY_MODE = { login: '#/entrar', register: '#/cadastro' };

export class AuthPanel {
  /**
   * @param {object} deps
   * @param {(session: object) => Promise<void>} deps.onAuthenticated
   */
  constructor({ onAuthenticated }) {
    this.onAuthenticated = onAuthenticated;
    this.notice = byId('auth-notice');
    this.tabs = { login: byId('tab-login'), register: byId('tab-register') };
    this.panels = { login: byId('panel-login'), register: byId('panel-register') };

    this.loginForm = byId('login-form');
    this.loginEmail = byId('login-email');
    this.loginPassword = byId('login-password');
    this.loginError = byId('login-error');
    this.loginSubmit = byId('login-submit');

    this.registerForm = byId('register-form');
    this.registerName = byId('register-name');
    this.registerEmail = byId('register-email');
    this.registerPassword = byId('register-password');
    this.registerConfirm = byId('register-password-confirm');
    this.registerPrivacy = byId('register-privacy');
    this.registerError = byId('register-error');
    this.registerSubmit = byId('register-submit');

    for (const [mode, tab] of Object.entries(this.tabs)) {
      tab.addEventListener('click', () => {
        window.location.hash = ROUTE_BY_MODE[mode];
      });
      tab.addEventListener('keydown', (event) => this.onTabKey(event, mode));
    }
    this.loginForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.login();
    });
    this.registerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.register();
    });
    for (const input of this.registerForm.querySelectorAll('input')) {
      input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    }
    for (const input of this.loginForm.querySelectorAll('input')) {
      input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    }
  }

  /** Shows the login or the register tab (driven by the hash route). */
  select(mode) {
    const current = mode === 'register' ? 'register' : 'login';
    for (const [name, tab] of Object.entries(this.tabs)) {
      const active = name === current;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      this.panels[name].hidden = !active;
    }
  }

  /** Message above the forms (session expired, account deleted…). Empty hides it. */
  setNotice(message, tone = 'info') {
    setAlert(this.notice, message, { tone });
  }

  /** Wipes typed passwords (logout, account deletion). */
  reset() {
    this.loginForm.reset();
    this.registerForm.reset();
    setAlert(this.loginError, '');
    setAlert(this.registerError, '');
  }

  focusFirstField(mode) {
    const field = mode === 'register' ? this.registerName : this.loginEmail;
    field.focus();
  }

  onTabKey(event, mode) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const other = mode === 'login' ? 'register' : 'login';
    this.tabs[other].focus();
    window.location.hash = ROUTE_BY_MODE[other];
  }

  invalid(input, message, errorBox) {
    input.setAttribute('aria-invalid', 'true');
    setAlert(errorBox, message);
    input.focus();
    return false;
  }

  async login() {
    setAlert(this.loginError, '');
    const email = this.loginEmail.value.trim();
    const password = this.loginPassword.value;
    if (!EMAIL_PATTERN.test(email)) {
      this.invalid(this.loginEmail, 'Informe um e-mail válido.', this.loginError);
      return;
    }
    if (!password) {
      this.invalid(this.loginPassword, 'Informe sua senha.', this.loginError);
      return;
    }

    const restore = setBusy(this.loginSubmit, 'Entrando…');
    try {
      const response = await api.login(email, password);
      this.setNotice('');
      this.loginPassword.value = '';
      await this.onAuthenticated(createSession(response));
    } catch (error) {
      this.showError(this.loginError, error);
      if (error?.code === 'A0001') {
        this.loginPassword.select();
        this.loginPassword.focus();
      }
    } finally {
      restore();
    }
  }

  validateRegistration() {
    const box = this.registerError;
    const name = this.registerName.value.trim();
    if (!name) return this.invalid(this.registerName, 'Informe seu nome.', box);
    if (name.length > 120) {
      return this.invalid(this.registerName, 'O nome pode ter no máximo 120 caracteres.', box);
    }
    if (!EMAIL_PATTERN.test(this.registerEmail.value.trim())) {
      return this.invalid(this.registerEmail, 'Informe um e-mail válido.', box);
    }
    const problem = passwordProblem(this.registerPassword.value);
    if (problem) return this.invalid(this.registerPassword, problem, box);
    if (this.registerConfirm.value !== this.registerPassword.value) {
      return this.invalid(this.registerConfirm, 'As senhas não conferem.', box);
    }
    if (!this.registerPrivacy.checked) {
      return this.invalid(
        this.registerPrivacy,
        'Para criar a conta, leia e aceite a Política de Privacidade.',
        box,
      );
    }
    return true;
  }

  async register() {
    setAlert(this.registerError, '');
    if (!this.validateRegistration()) return;
    const name = this.registerName.value.trim();
    const email = this.registerEmail.value.trim();
    const password = this.registerPassword.value;

    const restore = setBusy(this.registerSubmit, 'Criando conta…');
    try {
      await api.register({ name, email, password });
    } catch (error) {
      restore();
      this.showError(this.registerError, error);
      if (error?.code === 'A0002') this.registerEmail.focus();
      return;
    }

    try {
      const response = await api.login(email, password);
      this.registerForm.reset();
      await this.onAuthenticated(createSession(response));
    } catch {
      // Account exists; only the automatic sign-in failed (e.g. login throttled).
      this.registerForm.reset();
      this.loginEmail.value = email;
      window.location.hash = ROUTE_BY_MODE.login;
      this.setNotice('Conta criada! Entre com seu e-mail e senha.', 'success');
      this.loginPassword.focus();
    } finally {
      restore();
    }
  }

  showError(box, error) {
    let message = userMessage(error);
    if (error?.status === 429 && error.retryAfterSeconds) {
      message = `${message} Tente de novo em ${error.retryAfterSeconds} s.`;
    }
    setAlert(box, message, { supportId: error?.status >= 500 ? error.correlationId : null });
  }
}
