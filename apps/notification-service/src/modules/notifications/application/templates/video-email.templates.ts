import type { NotificationType } from '../../domain/notification';
import { escapeHtml, linkSafeText, singleLine, truncateText } from './text';

/** File names are shown truncated (long names break mail clients' layouts). */
export const ORIGINAL_NAME_MAX_LENGTH = 60;

/** Shown when nothing of the user's text survives {@link linkSafeText}. */
const FALLBACK_NAME = 'usuário';
const FALLBACK_FILE = 'enviado';

/** Fixed subjects: no user content in headers (no header injection, nothing personal). */
export const EMAIL_SUBJECTS: Readonly<Record<NotificationType, string>> = {
  VIDEO_FAILED: 'FIAP Frames: não foi possível processar o seu vídeo',
  VIDEO_COMPLETED: 'FIAP Frames: o seu vídeo foi processado',
};

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface VideoFailedTemplateData {
  userName: string;
  originalName: string;
  errorCode: string;
  errorMessage: string;
}

export interface VideoCompletedTemplateData {
  userName: string;
  originalName: string;
  frameCount: number;
}

const BRAND_COLOR = '#2f5bd3';
const FOOTER = 'E-mail automático do FIAP Frames. Não responda a esta mensagem.';

/**
 * `video.failed` e-mail (pt-BR). User values (name, file name) go through `linkSafeText` (no
 * URL, domain or address can appear: the e-mails leave our domain towards unverified addresses)
 * and are escaped; the only link is the app home page (`PUBLIC_BASE_URL`), never a download URL.
 */
export function renderVideoFailedEmail(
  data: VideoFailedTemplateData,
  publicBaseUrl: string,
): RenderedEmail {
  const name = displayName(data.userName);
  const file = displayFileName(data.originalName);
  const reason = singleLine(data.errorMessage);
  const code = singleLine(data.errorCode);
  const url = homeUrl(publicBaseUrl);
  const subject = EMAIL_SUBJECTS.VIDEO_FAILED;

  return {
    subject,
    html: layout(subject, name, url, [
      `Não foi possível processar o vídeo <strong>${escapeHtml(file)}</strong>.`,
      `Motivo: ${escapeHtml(reason)} (código ${escapeHtml(code)}).`,
      'Confira o arquivo e envie o vídeo novamente pelo FIAP Frames. O status de todos os seus ' +
        'vídeos fica na sua lista de envios.',
    ]),
    text: [
      `Olá, ${name}.`,
      '',
      `Não foi possível processar o vídeo "${file}".`,
      `Motivo: ${reason} (código ${code}).`,
      '',
      `Confira o arquivo e envie o vídeo novamente pelo FIAP Frames: ${url}`,
      '',
      FOOTER,
    ].join('\n'),
  };
}

/** `video.completed` e-mail (pt-BR), only with `NOTIFY_ON_SUCCESS=true`. */
export function renderVideoCompletedEmail(
  data: VideoCompletedTemplateData,
  publicBaseUrl: string,
): RenderedEmail {
  const name = displayName(data.userName);
  const file = displayFileName(data.originalName);
  const frames = framesLabel(data.frameCount);
  const url = homeUrl(publicBaseUrl);
  const subject = EMAIL_SUBJECTS.VIDEO_COMPLETED;

  return {
    subject,
    html: layout(subject, name, url, [
      `O vídeo <strong>${escapeHtml(file)}</strong> foi processado com sucesso: ${escapeHtml(frames)}.`,
      'O arquivo .zip com as imagens está disponível para download na sua lista de vídeos, ' +
        'por tempo limitado.',
    ]),
    text: [
      `Olá, ${name}.`,
      '',
      `O vídeo "${file}" foi processado com sucesso: ${frames}.`,
      'O arquivo .zip com as imagens está disponível para download na sua lista de vídeos, ' +
        `por tempo limitado: ${url}`,
      '',
      FOOTER,
    ].join('\n'),
  };
}

function displayName(userName: string): string {
  return truncateText(linkSafeText(userName), ORIGINAL_NAME_MAX_LENGTH) || FALLBACK_NAME;
}

/** `Férias 2026.MP4` → `Férias 2026 (.mp4)`: base name made link-safe + the extension. */
function displayFileName(originalName: string): string {
  const name = singleLine(originalName);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const hasExtension = /^[a-z0-9]{1,5}$/.test(extension);
  const base = truncateText(
    linkSafeText(hasExtension ? name.slice(0, dot) : name),
    ORIGINAL_NAME_MAX_LENGTH,
  );
  const shown = base || FALLBACK_FILE;
  return hasExtension ? `${shown} (.${extension})` : shown;
}

function homeUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/`;
}

function framesLabel(frameCount: number): string {
  const count = new Intl.NumberFormat('pt-BR').format(frameCount);
  return frameCount === 1 ? `${count} frame extraído` : `${count} frames extraídos`;
}

/** Minimal inline-styled layout (mail clients ignore <style> blocks and external CSS). */
function layout(subject: string, userName: string, url: string, paragraphs: string[]): string {
  const href = escapeHtml(url);
  const body = paragraphs.map((paragraph) => `<p style="margin:0 0 12px;">${paragraph}</p>`);
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif;' +
      'color:#1f2933;line-height:1.5;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px;">',
    '<div style="background:#ffffff;border-radius:8px;padding:24px;">',
    `<h1 style="font-size:20px;margin:0 0 16px;color:${BRAND_COLOR};">FIAP Frames</h1>`,
    `<p style="margin:0 0 12px;">Olá, <strong>${escapeHtml(userName)}</strong>.</p>`,
    ...body,
    '<p style="margin:24px 0;">',
    `<a href="${href}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;` +
      'padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">' +
      'Abrir o FIAP Frames</a></p>',
    '<p style="margin:0;font-size:13px;color:#52606d;">Se o botão não funcionar, copie e cole ' +
      `este endereço no navegador: ${href}</p>`,
    '</div>',
    `<p style="font-size:12px;color:#7b8794;margin:16px 0 0;">${FOOTER}</p>`,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}
