/* global document, window */
/*
 * Table of the user's videos (GET /api/videos), refreshed every 3 s while the tab is visible.
 * Rows are rebuilt only when the data changes, and the focused control is restored afterwards,
 * so keyboard users do not lose their place on each poll.
 */
import { api, isAbortError, safeDownloadUrl, userMessage } from './api.js';
import { el, followDownload, setAlert, setBusy } from './dom.js';
import {
  ZIP_RETENTION_DAYS,
  describeVideoError,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatRelative,
  isZipExpired,
  processingTime,
  statusLabel,
  videoAttempts,
} from './format.js';

export const POLL_INTERVAL_MS = 3000;
const PAGE_SIZE = 20;
/** After this many consecutive failures the indicator turns red (polling keeps going). */
const FAILURES_BEFORE_ALERT = 2;

export class VideosPanel {
  /**
   * @param {object} deps
   * @param {() => string | null} deps.getToken
   * @param {(message: string, tone?: string) => void} deps.notify
   */
  constructor({ getToken, notify }) {
    this.getToken = getToken;
    this.notify = notify;
    this.page = 1;
    this.status = '';
    this.timer = null;
    this.controller = null;
    this.running = false;
    this.failures = 0;
    this.lastSignature = null;
    this.lastData = null;
    this.downloading = new Set();
    this.knownExpired = new Set();

    this.body = document.getElementById('videos-body');
    this.table = this.body.closest('table');
    this.empty = document.getElementById('videos-empty');
    this.emptyText = document.getElementById('videos-empty-text');
    this.loading = document.getElementById('videos-loading');
    this.error = document.getElementById('videos-error');
    this.total = document.getElementById('videos-total');
    this.pagination = document.getElementById('pagination');
    this.pageLabel = document.getElementById('page-label');
    this.prev = document.getElementById('page-prev');
    this.next = document.getElementById('page-next');
    this.filter = document.getElementById('status-filter');
    this.refreshButton = document.getElementById('videos-refresh');
    this.indicator = document.getElementById('poll-indicator');
    this.indicatorText = document.getElementById('poll-text');

    this.prev.addEventListener('click', () => this.goTo(this.page - 1));
    this.next.addEventListener('click', () => this.goTo(this.page + 1));
    this.filter.addEventListener('change', () => {
      this.status = this.filter.value;
      this.goTo(1);
    });
    this.refreshButton.addEventListener('click', () => this.refreshNow());
    this.body.addEventListener('click', (event) => this.onBodyClick(event));
    document.addEventListener('visibilitychange', () => {
      if (!this.running) return;
      if (document.hidden) {
        this.clearTimer();
        this.setIndicator('paused', 'Atualização pausada (aba em segundo plano)');
      } else {
        this.refreshNow();
      }
    });
  }

  /** Starts polling (first load shows the spinner). */
  start() {
    if (this.running) return;
    this.running = true;
    this.loading.hidden = this.lastData !== null;
    this.refreshNow();
  }

  stop() {
    this.running = false;
    this.clearTimer();
    if (this.controller) this.controller.abort();
    this.controller = null;
  }

  /** Clears everything tied to the signed-in user (logout or account deletion). */
  reset() {
    this.stop();
    this.page = 1;
    this.status = '';
    this.filter.value = '';
    this.failures = 0;
    this.lastSignature = null;
    this.lastData = null;
    this.downloading.clear();
    this.knownExpired.clear();
    this.body.replaceChildren();
    this.total.textContent = '';
    this.empty.hidden = true;
    this.table.hidden = false;
    this.pagination.hidden = true;
    setAlert(this.error, '');
    this.setIndicator('idle', 'Atualiza sozinho a cada 3 s');
  }

  goTo(page) {
    this.page = Math.max(1, page);
    this.lastSignature = null;
    this.loading.hidden = false;
    this.refreshNow();
  }

  refreshNow() {
    this.clearTimer();
    void this.poll();
  }

  clearTimer() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    this.clearTimer();
    if (!this.running || document.hidden) return;
    this.timer = window.setTimeout(() => void this.poll(), POLL_INTERVAL_MS);
  }

  async poll() {
    const token = this.getToken();
    if (!token || !this.running) return;
    if (this.controller) this.controller.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setIndicator('loading', this.indicatorText.textContent);

    try {
      const data = await api.listVideos(
        token,
        { page: this.page, limit: PAGE_SIZE, status: this.status },
        controller.signal,
      );
      if (controller !== this.controller) return;
      this.failures = 0;
      setAlert(this.error, '');
      const lastPage = Math.max(1, Math.ceil((Number(data?.total) || 0) / PAGE_SIZE));
      if (this.page > lastPage) {
        // Items disappeared (filter changed on another tab, account data changed): step back.
        this.page = lastPage;
        this.lastSignature = null;
        this.refreshNow();
        return;
      }
      this.render(data);
      this.setIndicator('ok', `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`);
    } catch (error) {
      if (isAbortError(error) || controller !== this.controller) return;
      if (error?.status === 401) return; // app.js handles the expired session
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_ALERT || this.lastData === null) {
        setAlert(this.error, `Não foi possível atualizar a lista. ${userMessage(error)}`, {
          supportId: error?.status >= 500 ? error.correlationId : null,
        });
      }
      this.setIndicator('error', 'Sem conexão com o servidor. Tentando de novo…');
    } finally {
      if (controller === this.controller) {
        this.controller = null;
        this.loading.hidden = true;
        this.schedule();
      }
    }
  }

  setIndicator(state, text) {
    this.indicator.dataset.state = state;
    if (text) this.indicatorText.textContent = text;
  }

  render(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    const total = Number(data?.total) || 0;
    const signature = JSON.stringify([
      items,
      total,
      this.page,
      [...this.downloading],
      [...this.knownExpired],
    ]);
    this.lastData = data;
    this.total.textContent =
      total === 0 ? '' : total === 1 ? '1 vídeo' : `${formatCount(total)} vídeos`;
    this.renderPagination(total);
    if (signature === this.lastSignature) {
      this.refreshRelativeTimes();
      return;
    }
    this.lastSignature = signature;

    if (items.length === 0) {
      this.body.replaceChildren();
      this.table.hidden = true;
      this.empty.hidden = false;
      this.emptyText.textContent = this.status
        ? `Nenhum vídeo com o status "${statusLabel(this.status)}".`
        : 'Nenhum vídeo ainda. Envie o primeiro aqui em cima.';
      return;
    }

    const focus = this.captureFocus();
    this.table.hidden = false;
    this.empty.hidden = true;
    this.body.replaceChildren(...items.map((video) => this.renderRow(video)));
    this.restoreFocus(focus);
  }

  renderPagination(total) {
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    this.pagination.hidden = lastPage <= 1;
    this.pageLabel.textContent = `Página ${this.page} de ${lastPage}`;
    this.prev.disabled = this.page <= 1;
    this.next.disabled = this.page >= lastPage;
  }

  renderRow(video) {
    const expired = video.status === 'COMPLETED' && isZipExpired(video, this.knownExpired);
    const uploaded = el('time', {
      className: 'rel-time',
      text: formatRelative(video.createdAt),
      attrs: { datetime: video.createdAt ?? false, title: formatDateTime(video.createdAt) },
      dataset: { at: video.createdAt ?? '' },
    });

    return el('tr', { dataset: { id: video.id, status: expired ? 'EXPIRED' : video.status } }, [
      el('td', { className: 'cell-video', dataset: { label: 'Vídeo' } }, [
        el('span', {
          className: 'video-name',
          text: video.originalName ?? '—',
          attrs: { title: video.originalName ?? false },
        }),
        el('span', {
          className: 'video-sub mono',
          text: [formatBytes(video.sizeBytes), shortId(video.id)].filter(Boolean).join(' · '),
        }),
      ]),
      el('td', { dataset: { label: 'Enviado' } }, [uploaded]),
      el('td', { className: 'cell-status', dataset: { label: 'Status' } }, [
        this.renderBadge(video, expired),
        this.renderStatusDetail(video, expired),
      ]),
      el('td', { className: 'num', dataset: { label: 'Frames' } }, [
        el('span', { className: 'mono', text: formatCount(video.frameCount) }),
        video.zipSizeBytes && !expired
          ? el('span', { className: 'video-sub mono', text: formatBytes(video.zipSizeBytes) })
          : null,
      ]),
      el('td', { className: 'actions-col', dataset: { label: 'Ações' } }, [
        this.renderAction(video, expired),
      ]),
    ]);
  }

  renderBadge(video, expired) {
    if (expired) {
      return el('span', {
        className: 'badge',
        text: 'Expirado',
        dataset: { status: 'EXPIRED' },
      });
    }
    return el('span', {
      className: 'badge',
      text: statusLabel(video.status),
      dataset: { status: video.status ?? '' },
    });
  }

  renderStatusDetail(video, expired) {
    if (expired) {
      const when = video.expiredAt ? ` em ${formatDateTime(video.expiredAt)}` : '';
      return el('span', {
        className: 'status-detail',
        text: `O .zip foi removido${when} (fica disponível por ${ZIP_RETENTION_DAYS} dias).`,
      });
    }
    switch (video.status) {
      case 'FAILED': {
        const { code, message } = describeVideoError(video);
        return el('span', { className: 'status-detail status-error' }, [
          message,
          code ? el('span', { className: 'code mono', text: code }) : null,
        ]);
      }
      case 'PROCESSING': {
        const attempts = videoAttempts(video);
        return attempts > 1
          ? el('span', { className: 'status-detail', text: `Tentativa ${attempts}` })
          : el('span', { className: 'status-detail', text: 'Extraindo frames…' });
      }
      case 'COMPLETED': {
        const took = processingTime(video);
        return took === null
          ? null
          : el('span', { className: 'status-detail', text: `Pronto em ${formatDuration(took)}` });
      }
      case 'QUEUED':
        return el('span', { className: 'status-detail', text: 'Aguardando um worker' });
      default:
        return null;
    }
  }

  renderAction(video, expired) {
    if (video.status !== 'COMPLETED' || expired) return null;
    const busy = this.downloading.has(video.id);
    return el(
      'button',
      {
        className: 'btn btn-secondary btn-sm btn-download',
        attrs: {
          type: 'button',
          disabled: busy,
          'aria-busy': busy ? 'true' : false,
          'aria-label': `Baixar frames de ${video.originalName ?? 'vídeo'}`,
        },
        dataset: { action: 'download', id: video.id },
      },
      [
        el('span', { className: 'download-glyph', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'btn-label', text: busy ? 'Gerando link…' : 'Baixar .zip' }),
      ],
    );
  }

  /** Relative times ("há 2 minutos") move even when the data does not. */
  refreshRelativeTimes() {
    for (const node of this.body.querySelectorAll('time.rel-time')) {
      node.textContent = formatRelative(node.dataset.at || null);
    }
  }

  captureFocus() {
    const active = document.activeElement;
    if (!active || !this.body.contains(active)) return null;
    return { id: active.dataset.id, action: active.dataset.action };
  }

  restoreFocus(focus) {
    if (!focus?.id || !focus.action) return;
    const target = Array.from(this.body.querySelectorAll('[data-action]')).find(
      (node) => node.dataset.id === focus.id && node.dataset.action === focus.action,
    );
    if (target) target.focus();
  }

  onBodyClick(event) {
    const button = event.target.closest('button[data-action="download"]');
    if (!button || button.disabled) return;
    void this.download(button.dataset.id, button);
  }

  /** POST download-url, then follow the signed URL (valid for a few minutes, one per click). */
  async download(id, button) {
    const token = this.getToken();
    if (!token || this.downloading.has(id)) return;
    this.downloading.add(id);
    const restore = setBusy(button, 'Gerando link…');
    try {
      const response = await api.createDownloadUrl(token, id);
      const url = safeDownloadUrl(response?.url, window.location.origin);
      if (!url) throw new Error('invalid download url');
      followDownload(url);
      this.notify('Download iniciado.', 'success');
    } catch (error) {
      if (error?.status === 401) return;
      if (error?.status === 410) {
        this.knownExpired.add(id);
        this.notify(userMessage(error), 'warn');
      } else if (error?.status === 409) {
        this.notify(userMessage(error), 'warn');
      } else if (error?.status !== undefined) {
        this.notify(`Não foi possível gerar o link. ${userMessage(error)}`, 'error');
      } else {
        this.notify('O servidor devolveu um link de download inválido.', 'error');
      }
    } finally {
      this.downloading.delete(id);
      if (button.isConnected) restore();
      this.lastSignature = null;
      if (this.lastData) this.render(this.lastData);
    }
  }
}

function shortId(id) {
  return typeof id === 'string' && id.length >= 8 ? `#${id.slice(0, 8)}` : '';
}
