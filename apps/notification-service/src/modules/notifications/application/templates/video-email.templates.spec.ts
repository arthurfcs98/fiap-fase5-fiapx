import {
  EMAIL_SUBJECTS,
  ORIGINAL_NAME_MAX_LENGTH,
  renderVideoCompletedEmail,
  renderVideoFailedEmail,
} from './video-email.templates';

const BASE_URL = 'https://fiapx.asdevit.com';

describe('video e-mail templates (pt-BR)', () => {
  describe('VIDEO_FAILED', () => {
    const email = renderVideoFailedEmail(
      {
        userName: 'Ana <b>& "Bia"</b>',
        originalName: '<img src=x onerror=alert(1)>.mp4',
        errorCode: 'P0001',
        errorMessage: 'O arquivo não é um vídeo válido ou está corrompido.',
      },
      BASE_URL,
    );

    it('uses the fixed subject (no user content in headers)', () => {
      expect(email.subject).toBe(EMAIL_SUBJECTS.VIDEO_FAILED);
      expect(email.subject).toBe('FIAP Frames: não foi possível processar o seu vídeo');
    });

    it('user values reach the HTML only as plain, link-safe text', () => {
      expect(email.html).toContain('Olá, <strong>Ana b Bia b</strong>.');
      expect(email.html).toContain('<strong>img src x onerror alert 1 (.mp4)</strong>');
      expect(email.html).not.toContain('<img');
      expect(email.html).not.toContain('<b>');
      expect(email.html).toContain(
        'Motivo: O arquivo não é um vídeo válido ou está corrompido. (código P0001).',
      );
    });

    it('links only to the app home page, never to a download URL', () => {
      const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
      expect(hrefs).toEqual([`${BASE_URL}/`]);
      expect(email.html).not.toMatch(/download/i);
      expect(email.text).toContain(
        `Confira o arquivo e envie o vídeo novamente pelo FIAP Frames: ${BASE_URL}/`,
      );
    });

    it('has a plain-text version with the same content', () => {
      expect(email.text).toBe(
        [
          'Olá, Ana b Bia b.',
          '',
          'Não foi possível processar o vídeo "img src x onerror alert 1 (.mp4)".',
          'Motivo: O arquivo não é um vídeo válido ou está corrompido. (código P0001).',
          '',
          `Confira o arquivo e envie o vídeo novamente pelo FIAP Frames: ${BASE_URL}/`,
          '',
          'E-mail automático do FIAP Frames. Não responda a esta mensagem.',
        ].join('\n'),
      );
    });
  });

  describe('VIDEO_COMPLETED', () => {
    it('shows the frame count in pt-BR, singular and plural', () => {
      const many = renderVideoCompletedEmail(
        { userName: 'Ana', originalName: 'aula.mp4', frameCount: 1234 },
        `${BASE_URL}/`,
      );
      expect(many.subject).toBe('FIAP Frames: o seu vídeo foi processado');
      expect(many.html).toContain(
        '<strong>aula (.mp4)</strong> foi processado com sucesso: 1.234 frames extraídos.',
      );
      expect(many.text).toContain(
        'O vídeo "aula (.mp4)" foi processado com sucesso: 1.234 frames extraídos.',
      );
      expect(many.text).toContain(`por tempo limitado: ${BASE_URL}/`);

      const one = renderVideoCompletedEmail(
        { userName: 'Ana', originalName: 'curto.mp4', frameCount: 1 },
        BASE_URL,
      );
      expect(one.text).toContain('1 frame extraído.');
    });

    it('truncates long file names and neutralizes line breaks and addresses in names', () => {
      const email = renderVideoCompletedEmail(
        { userName: 'Ana\r\nBcc: x@y.z', originalName: `${'a'.repeat(200)}.mp4`, frameCount: 2 },
        BASE_URL,
      );
      const shown = `${'a'.repeat(ORIGINAL_NAME_MAX_LENGTH - 1)}…`;
      expect(email.text).toContain(`O vídeo "${shown} (.mp4)"`);
      expect(email.text).toContain('Olá, Ana Bcc x y z.');
      expect(email.html).not.toContain('a'.repeat(ORIGINAL_NAME_MAX_LENGTH));
    });

    it('anti-phishing: no link, domain or address can come from the user text', () => {
      const email = renderVideoFailedEmail(
        {
          userName: 'Seu Pix foi bloqueado: acesse https://golpe.com.br/pix',
          originalName: 'regularize em www.golpe.com.br agora.mp4',
          errorCode: 'P0001',
          errorMessage: 'x',
        },
        BASE_URL,
      );
      for (const part of [email.html, email.text]) {
        expect(part).not.toMatch(/golpe\.com|https:\/\/golpe|www\./);
      }
      expect(email.text).toContain('Olá, Seu Pix foi bloqueado acesse https golpe com br pix.');
      expect(email.text).toContain('"regularize em www golpe com br agora (.mp4)"');
    });

    it('keeps accents and falls back when nothing of the user text is left', () => {
      const accents = renderVideoCompletedEmail(
        { userName: "João D'Ávila", originalName: 'Férias 2026.MP4', frameCount: 3 },
        BASE_URL,
      );
      expect(accents.text).toContain("Olá, João D'Ávila.");
      expect(accents.text).toContain('"Férias 2026 (.mp4)"');

      const empty = renderVideoFailedEmail(
        { userName: '...', originalName: '...', errorCode: 'P0001', errorMessage: 'x' },
        BASE_URL,
      );
      expect(empty.text).toContain('Olá, usuário.');
      expect(empty.text).toContain('o vídeo "enviado"');
      const noExtension = renderVideoFailedEmail(
        { userName: 'Ana', originalName: 'sem extensao', errorCode: 'P0001', errorMessage: 'x' },
        BASE_URL,
      );
      expect(noExtension.text).toContain('o vídeo "sem extensao"');
    });
  });
});
