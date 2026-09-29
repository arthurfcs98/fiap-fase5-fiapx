/*
 * "Meus dados": LGPD self-service (contratos.md, section 12).
 * - Access and portability: GET /api/me/data, saved as a JSON file.
 * - Erasure: DELETE /api/me with the password as confirmation (204). A wrong password is
 *   400 A0004 (not 401), so it never ends the session by accident.
 */
import { api, userMessage } from './api.js';
import { byId, saveBlob, setAlert, setBusy } from './dom.js';
import { exportFileName } from './format.js';

export class AccountPanel {
  /**
   * @param {object} deps
   * @param {() => string | null} deps.getToken
   * @param {(message: string, tone?: string) => void} deps.notify
   * @param {() => void} deps.onDeleted  account erased: clear the session and show the login
   */
  constructor({ getToken, notify, onDeleted }) {
    this.getToken = getToken;
    this.notify = notify;
    this.onDeleted = onDeleted;

    this.name = byId('account-name');
    this.email = byId('account-email');
    this.id = byId('account-id');
    this.exportButton = byId('export-button');
    this.exportError = byId('export-error');
    this.dialog = byId('delete-dialog');
    this.form = byId('delete-form');
    this.password = byId('delete-password');
    this.username = byId('delete-username');
    this.ack = byId('delete-ack');
    this.deleteError = byId('delete-error');
    this.deleteSubmit = byId('delete-submit');

    this.exportButton.addEventListener('click', () => void this.exportData());
    byId('delete-open').addEventListener('click', () => this.openDialog());
    byId('delete-cancel').addEventListener('click', () => this.closeDialog());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.deleteAccount();
    });
    // Esc closes the native dialog; also clear the password it held.
    this.dialog.addEventListener('close', () => this.resetDialog());
  }

  /** Fills the profile card from the cached session user. */
  showUser(user) {
    this.name.textContent = user?.name || '—';
    this.email.textContent = user?.email || '—';
    this.id.textContent = user?.id || '—';
    this.username.value = user?.email || '';
  }

  reset() {
    this.showUser(null);
    setAlert(this.exportError, '');
    if (this.dialog.open) this.dialog.close();
    this.resetDialog();
  }

  async exportData() {
    const token = this.getToken();
    if (!token) return;
    setAlert(this.exportError, '');
    const restore = setBusy(this.exportButton, 'Preparando arquivo…');
    try {
      const data = await api.myData(token);
      const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
        type: 'application/json',
      });
      saveBlob(blob, exportFileName());
      this.notify('Seus dados foram baixados.', 'success');
    } catch (error) {
      if (error?.status === 401) return;
      setAlert(this.exportError, userMessage(error), {
        supportId: error?.status >= 500 ? error.correlationId : null,
      });
    } finally {
      restore();
    }
  }

  openDialog() {
    this.resetDialog();
    this.dialog.showModal();
    this.password.focus();
  }

  closeDialog() {
    if (this.dialog.open) this.dialog.close();
  }

  resetDialog() {
    const email = this.username.value;
    this.form.reset();
    this.username.value = email;
    setAlert(this.deleteError, '');
    this.password.removeAttribute('aria-invalid');
  }

  async deleteAccount() {
    const token = this.getToken();
    if (!token) return;
    setAlert(this.deleteError, '');
    const password = this.password.value;
    if (!password) {
      this.password.setAttribute('aria-invalid', 'true');
      setAlert(this.deleteError, 'Digite sua senha para confirmar.');
      this.password.focus();
      return;
    }
    if (!this.ack.checked) {
      setAlert(this.deleteError, 'Marque a confirmação de que a exclusão é definitiva.');
      this.ack.focus();
      return;
    }

    const restore = setBusy(this.deleteSubmit, 'Excluindo…');
    try {
      await api.deleteAccount(token, password);
      restore();
      this.closeDialog();
      this.onDeleted();
    } catch (error) {
      restore();
      if (error?.status === 401) {
        this.closeDialog();
        return;
      }
      if (error?.code === 'A0004') {
        this.password.setAttribute('aria-invalid', 'true');
        this.password.select();
      }
      setAlert(this.deleteError, userMessage(error), {
        supportId: error?.status >= 500 ? error.correlationId : null,
      });
      if (error?.code === 'A0004') this.password.focus();
    }
  }
}
