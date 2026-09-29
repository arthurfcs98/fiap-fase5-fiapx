import { setTimeout as sleep } from 'node:timers/promises';

export interface WaitForOptions {
  /** Padrão: 15 s. */
  timeoutMs?: number;
  /** Padrão: 100 ms. */
  intervalMs?: number;
  /** Aparece na mensagem de timeout. */
  description?: string;
}

/**
 * Espera `probe` devolver um valor "truthy" (tolerando exceções enquanto espera) e o devolve.
 * Para testes de integração assíncronos (filas, storage, containers).
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  options: WaitForOptions = {},
): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? ` (último erro: ${lastError.message})` : '';
      throw new Error(
        `waitFor: timeout de ${timeoutMs} ms: ${options.description ?? 'condição'}${detail}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Pausa explícita (ex.: garantir que NADA mais chega depois de um estado final). */
export function delay(ms: number): Promise<void> {
  return sleep(ms);
}
