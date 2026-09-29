import { defineFeature, loadFeature } from 'jest-cucumber';
import { EMAIL_DOMAIN, FILE_MARKER, PERSONAL_MARKER } from '../support/api';
import { stackLogs } from '../support/compose';

const feature = loadFeature('tests/bdd/features/99-logs-sem-dados-pessoais.feature');

/** Technical addresses that are not personal data (e-mail Message-ID and the local sender). */
const TECHNICAL_ADDRESS = /@(fiapx\.notification|fiapx\.local)$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

defineFeature(feature, (test) => {
  test('os logs do stack não contêm e-mail, nome, nome de arquivo nem link assinado', ({
    when,
    then,
    and,
  }) => {
    let logs = '';

    when('leio os logs de todos os serviços do stack', async () => {
      // Every container of the project: apps AND infra (Postgres, RabbitMQ, Mailpit...).
      logs = await stackLogs();
      expect(logs.length).toBeGreaterThan(0);
    });

    then('nenhum e-mail de usuário aparece nos logs', () => {
      const addresses = [...logs.matchAll(EMAIL_PATTERN)].map((match) => match[0]);
      const personal = addresses.filter((address) => !TECHNICAL_ADDRESS.test(address));
      expect(personal).toEqual([]);
      expect(logs).not.toContain(`@${EMAIL_DOMAIN}`);
    });

    and('nenhum nome de usuário aparece nos logs', () => {
      expect(logs).not.toContain(PERSONAL_MARKER);
    });

    and('nenhum nome de arquivo enviado aparece nos logs', () => {
      expect(logs).not.toContain(FILE_MARKER);
      expect(logs).not.toContain('sample-ok');
      expect(logs).not.toContain('sample-corrupt');
    });

    and('nenhuma assinatura de link de download aparece nos logs', () => {
      expect(logs).not.toMatch(/[?&]sig=/);
    });
  });
});
