/* global window */
/*
 * Multi-file upload queue. The API takes ONE file per POST /api/videos, so each selected file
 * becomes its own request, up to MAX_PARALLEL_UPLOADS at a time, each with:
 * - its own progress bar (XMLHttpRequest upload progress);
 * - its own Idempotency-Key, generated once and reused on every retry of that file, so a retry
 *   after a lost response never creates a second video;
 * - automatic retries only for 429/503 (Retry-After or exponential backoff). Other errors stop
 *   and offer a manual "Tentar de novo" with the same key;
 * - 429 V0007 (the user already has as many videos in progress as allowed) is a normal wait,
 *   not a failure: the file waits (Retry-After) until a video finishes, with its own budget.
 */
import { ApiError, isAbortError, uploadVideo, userMessage } from './api.js';
import { el, setAlert } from './dom.js';
import {
  DEFAULT_MAX_UPLOAD_MB,
  MAX_PARALLEL_UPLOADS,
  formatBytes,
  formatPercent,
  isAllowedVideoName,
  uuid,
} from './format.js';

const MAX_AUTO_RETRIES = 3;
const BACKOFF_BASE_S = 2;
const BACKOFF_MAX_S = 30;
/** V0007 waits (about 10 min with the 15 s Retry-After): the queue of the user drains. */
const MAX_PENDING_WAITS = 40;
const PENDING_VIDEOS_CODE = 'V0007';

/** Item states; `data-state` on the row drives the styling. */
const STATE = Object.freeze({
  INVALID: 'invalid',
  READY: 'ready',
  WAITING: 'waiting',
  UPLOADING: 'uploading',
  VALIDATING: 'validating',
  RETRY_WAIT: 'retry-wait',
  DONE: 'done',
  ERROR: 'error',
  CANCELED: 'canceled',
});

const ACTIVE_STATES = new Set([STATE.WAITING, STATE.UPLOADING, STATE.VALIDATING, STATE.RETRY_WAIT]);
const FINISHED_STATES = new Set([STATE.DONE, STATE.INVALID, STATE.CANCELED]);

function fileProblem(file, maxBytes) {
  if (!isAllowedVideoName(file.name)) {
    return 'Formato não suportado. Use .mp4, .avi, .mov, .mkv, .wmv, .flv ou .webm.';
  }
  if (file.size === 0) return 'O arquivo está vazio.';
  if (file.size > maxBytes) {
    return `Arquivo maior que o limite de ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  }
  return null;
}

function fileSignature(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

export class UploadQueue {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.list        <ul> receiving one <li> per file
   * @param {HTMLElement} deps.panel       wrapper shown when the list has items
   * @param {HTMLElement} deps.summary     live text ("2 de 3 enviados")
   * @param {HTMLButtonElement} deps.startButton
   * @param {HTMLButtonElement} deps.clearButton
   * @param {() => string | null} deps.getToken
   * @param {(video: object) => void} deps.onAccepted  called after each 202
   * @param {(message: string, tone?: string) => void} deps.notify
   */
  constructor({ list, panel, summary, startButton, clearButton, getToken, onAccepted, notify }) {
    this.list = list;
    this.panel = panel;
    this.summary = summary;
    this.startButton = startButton;
    this.clearButton = clearButton;
    this.getToken = getToken;
    this.onAccepted = onAccepted;
    this.notify = notify;
    this.items = [];
    this.maxBytes = DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;

    startButton.addEventListener('click', () => this.startAll());
    clearButton.addEventListener('click', () => this.clearFinished());
    this.render();
  }

  /** True while any file is uploading, waiting for a slot or waiting to retry. */
  get busy() {
    return this.items.some((item) => ACTIVE_STATES.has(item.state));
  }

  get activeCount() {
    return this.items.filter(
      (item) => item.state === STATE.UPLOADING || item.state === STATE.VALIDATING,
    ).length;
  }

  /** Adds files from an <input type=file> or a drop. Invalid ones stay listed with the reason. */
  add(fileList) {
    const files = Array.from(fileList ?? []);
    const known = new Set(
      this.items
        .filter((item) => item.state !== STATE.CANCELED && item.state !== STATE.INVALID)
        .map((item) => item.signature),
    );
    let duplicates = 0;
    for (const file of files) {
      const signature = fileSignature(file);
      if (known.has(signature)) {
        duplicates += 1;
        continue;
      }
      known.add(signature);
      const problem = fileProblem(file, this.maxBytes);
      const item = {
        id: uuid(),
        file,
        signature,
        idempotencyKey: uuid(),
        correlationId: uuid(),
        state: problem ? STATE.INVALID : STATE.READY,
        message: problem,
        loaded: 0,
        total: file.size,
        autoRetries: 0,
        pendingWaits: 0,
        handle: null,
        timer: null,
        videoId: null,
      };
      item.row = this.createRow(item);
      this.items.push(item);
      this.list.append(item.row.root);
      this.updateRow(item);
    }
    if (duplicates > 0) {
      this.notify(
        duplicates === 1
          ? 'Um arquivo já estava na lista e foi ignorado.'
          : `${duplicates} arquivos já estavam na lista e foram ignorados.`,
      );
    }
    this.render();
  }

  /** Sends every file that is ready (in parallel, limited by MAX_PARALLEL_UPLOADS). */
  startAll() {
    for (const item of this.items) {
      if (item.state === STATE.READY) this.setState(item, STATE.WAITING, null);
    }
    this.pump();
  }

  /** Removes finished rows (sent, invalid, canceled) and ready ones that were never sent. */
  clearFinished() {
    const keep = [];
    for (const item of this.items) {
      if (FINISHED_STATES.has(item.state) || item.state === STATE.READY) {
        item.row.root.remove();
      } else {
        keep.push(item);
      }
    }
    this.items = keep;
    this.render();
  }

  /** Cancels everything (logout or account deletion). */
  abortAll() {
    for (const item of this.items) {
      window.clearTimeout(item.timer);
      if (item.handle) item.handle.abort();
    }
    this.items = [];
    this.list.replaceChildren();
    this.render();
  }

  pump() {
    while (this.activeCount < MAX_PARALLEL_UPLOADS) {
      const next = this.items.find((item) => item.state === STATE.WAITING);
      if (!next) break;
      void this.run(next);
    }
    this.render();
  }

  async run(item) {
    const token = this.getToken();
    if (!token) {
      this.setState(item, STATE.ERROR, 'Sessão encerrada. Entre novamente para enviar.');
      return;
    }
    item.loaded = 0;
    this.setState(item, STATE.UPLOADING, null);

    const handle = uploadVideo({
      file: item.file,
      token,
      idempotencyKey: item.idempotencyKey,
      correlationId: item.correlationId,
      onProgress: (loaded, total) => {
        item.loaded = loaded;
        item.total = total;
        this.updateRow(item);
      },
      onSent: () => {
        item.loaded = item.total;
        this.setState(item, STATE.VALIDATING, null);
      },
    });
    item.handle = handle;

    try {
      const video = await handle.promise;
      item.handle = null;
      item.videoId = typeof video?.id === 'string' ? video.id : null;
      item.loaded = item.total;
      this.setState(item, STATE.DONE, null);
      this.onAccepted(video);
    } catch (error) {
      item.handle = null;
      this.handleFailure(item, error);
    } finally {
      this.pump();
    }
  }

  handleFailure(item, error) {
    if (isAbortError(error)) {
      this.setState(item, STATE.CANCELED, 'Envio cancelado.');
      return;
    }
    const apiError =
      error instanceof ApiError ? error : new ApiError({ status: 0, description: String(error) });

    if (apiError.status === 401) {
      // The session handler logs the user out; keep the row explaining why it stopped.
      this.setState(item, STATE.ERROR, userMessage(apiError));
      return;
    }
    if (apiError.code === PENDING_VIDEOS_CODE && item.pendingWaits < MAX_PENDING_WAITS) {
      item.pendingWaits += 1;
      const waitSeconds = Math.max(1, apiError.retryAfterSeconds ?? 15);
      this.waitAndRetry(
        item,
        waitSeconds,
        `${apiError.description} Nova tentativa em ${waitSeconds} s.`,
      );
      return;
    }
    if (apiError.isRetryable && item.autoRetries < MAX_AUTO_RETRIES) {
      item.autoRetries += 1;
      const backoff = Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S ** item.autoRetries);
      const waitSeconds = Math.max(1, apiError.retryAfterSeconds ?? backoff);
      this.waitAndRetry(
        item,
        waitSeconds,
        `Servidor ocupado. Nova tentativa em ${waitSeconds} s (${item.autoRetries}/${MAX_AUTO_RETRIES}).`,
      );
      return;
    }
    item.error = apiError;
    this.setState(item, STATE.ERROR, userMessage(apiError));
  }

  waitAndRetry(item, waitSeconds, message) {
    this.setState(item, STATE.RETRY_WAIT, message);
    item.timer = window.setTimeout(() => {
      item.timer = null;
      if (item.state !== STATE.RETRY_WAIT) return;
      this.setState(item, STATE.WAITING, null);
      this.pump();
    }, waitSeconds * 1000);
  }

  retry(item) {
    item.autoRetries = 0;
    item.pendingWaits = 0;
    item.error = null;
    this.setState(item, STATE.WAITING, null);
    this.pump();
  }

  cancel(item) {
    if (item.handle) {
      item.handle.abort();
      return;
    }
    window.clearTimeout(item.timer);
    item.timer = null;
    this.setState(item, STATE.CANCELED, 'Envio cancelado.');
    this.pump();
  }

  remove(item) {
    if (item.handle) return;
    window.clearTimeout(item.timer);
    item.row.root.remove();
    this.items = this.items.filter((candidate) => candidate !== item);
    this.render();
  }

  setState(item, state, message) {
    item.state = state;
    item.message = message;
    this.updateRow(item);
    this.render();
  }

  createRow(item) {
    const name = el('span', {
      className: 'upload-name',
      text: item.file.name,
      attrs: { title: item.file.name },
    });
    const size = el('span', { className: 'upload-size mono', text: formatBytes(item.file.size) });
    const progress = el('progress', {
      className: 'progress',
      attrs: { max: '100', value: '0', 'aria-label': `Progresso do envio de ${item.file.name}` },
    });
    const status = el('span', { className: 'upload-status' });
    const actions = el('span', { className: 'upload-row-actions' });
    const detail = el('div', { className: 'upload-detail alert', attrs: { hidden: true } });
    const root = el('li', { className: 'upload-item' }, [
      el('div', { className: 'upload-line' }, [
        el('span', { className: 'file-glyph', attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'upload-meta' }, [name, size]),
        actions,
      ]),
      progress,
      el('div', { className: 'upload-foot' }, [status]),
      detail,
    ]);
    return { root, progress, status, actions, detail, actionsState: null };
  }

  updateRow(item) {
    const { root, progress, status, actions, detail } = item.row;
    root.dataset.state = item.state;
    const percent = formatPercent(item.loaded, item.total);
    progress.value = item.state === STATE.DONE ? 100 : percent;
    progress.textContent = `${percent}%`;

    const labels = {
      [STATE.INVALID]: 'Não será enviado',
      [STATE.READY]: 'Pronto para enviar',
      [STATE.WAITING]: 'Aguardando vez…',
      [STATE.UPLOADING]: `Enviando… ${percent}% · ${formatBytes(item.loaded)} de ${formatBytes(item.total)}`,
      [STATE.VALIDATING]: 'Enviado. Validando o arquivo…',
      [STATE.RETRY_WAIT]: 'Aguardando nova tentativa',
      [STATE.DONE]: 'Recebido. Na fila de processamento.',
      [STATE.ERROR]: 'Falhou',
      [STATE.CANCELED]: 'Cancelado',
    };
    status.textContent = labels[item.state] ?? item.state;

    const showDetail =
      Boolean(item.message) && [STATE.INVALID, STATE.ERROR, STATE.RETRY_WAIT].includes(item.state);
    setAlert(detail, showDetail ? item.message : '', {
      tone: item.state === STATE.RETRY_WAIT ? 'warn' : 'error',
      supportId:
        item.state === STATE.ERROR && item.error?.status >= 500 ? item.error.correlationId : null,
    });

    // Buttons are rebuilt only when the state changes: progress events fire many times per
    // second and replacing the node under the pointer would swallow the click.
    if (item.row.actionsState === item.state) return;
    item.row.actionsState = item.state;
    actions.replaceChildren();
    const button = (label, handler, className = 'btn btn-ghost btn-xs') => {
      const node = el('button', {
        className,
        text: label,
        attrs: { type: 'button', 'aria-label': `${label}: ${item.file.name}` },
      });
      node.addEventListener('click', handler);
      actions.append(node);
    };
    switch (item.state) {
      case STATE.UPLOADING:
      case STATE.WAITING:
      case STATE.RETRY_WAIT:
        button('Cancelar', () => this.cancel(item));
        break;
      case STATE.ERROR:
        button('Tentar de novo', () => this.retry(item), 'btn btn-secondary btn-xs');
        button('Remover', () => this.remove(item));
        break;
      case STATE.READY:
      case STATE.INVALID:
      case STATE.CANCELED:
        button('Remover', () => this.remove(item));
        break;
      default:
        break;
    }
  }

  /** Panel visibility, summary line and the start button label. */
  render() {
    const total = this.items.length;
    this.panel.hidden = total === 0;
    const count = (state) => this.items.filter((item) => item.state === state).length;
    const ready = count(STATE.READY);
    const done = count(STATE.DONE);
    const failed = count(STATE.ERROR);
    const invalid = count(STATE.INVALID);
    const active = this.items.filter((item) => ACTIVE_STATES.has(item.state)).length;

    const label = this.startButton.querySelector('.btn-label') ?? this.startButton;
    label.textContent =
      ready === 0 ? 'Enviar' : ready === 1 ? 'Enviar 1 vídeo' : `Enviar ${ready} vídeos`;
    this.startButton.disabled = ready === 0;
    this.clearButton.disabled = total === 0 || active === total;

    const parts = [];
    if (active > 0) parts.push(`${active} em andamento`);
    if (done > 0) parts.push(done === 1 ? '1 recebido' : `${done} recebidos`);
    if (failed > 0) parts.push(failed === 1 ? '1 com erro' : `${failed} com erro`);
    if (invalid > 0) parts.push(invalid === 1 ? '1 recusado' : `${invalid} recusados`);
    if (parts.length === 0 && ready > 0) {
      parts.push(ready === 1 ? '1 arquivo pronto' : `${ready} arquivos prontos`);
    }
    this.summary.textContent = parts.join(' · ');
  }
}
