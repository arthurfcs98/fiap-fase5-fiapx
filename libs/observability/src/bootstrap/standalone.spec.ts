import { Injectable, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { createPinoConfig } from '../logging';
import { createStandaloneApp, exitOnBootstrapError } from './standalone';

@Injectable()
class Probe {
  readonly ok = true;
}

@Module({
  imports: [LoggerModule.forRoot(createPinoConfig({ serviceName: 'test', level: 'silent' }))],
  providers: [Probe],
})
class TestRootModule {}

describe('createStandaloneApp', () => {
  it('cria o contexto com logger pino e registra shutdown hooks em SIGTERM/SIGINT', async () => {
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sigintBefore = process.listenerCount('SIGINT');

    const app = await createStandaloneApp(TestRootModule);

    expect(app.get(Probe).ok).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);

    await app.close();
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('propaga erros de inicialização (sem abortar o processo)', async () => {
    @Module({
      providers: [
        {
          provide: 'BROKEN',
          useFactory: () => {
            throw new Error('config inválida');
          },
        },
      ],
    })
    class BrokenModule {}

    await expect(createStandaloneApp(BrokenModule)).rejects.toThrow('config inválida');
  });
});

describe('exitOnBootstrapError', () => {
  it('escreve a causa no stderr e sai com código 1', () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = jest.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

    expect(() => exitOnBootstrapError('video-worker', exit)(new Error('boom'))).toThrow('exit 1');
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('[video-worker] falha ao iniciar: Error: boom'),
    );

    expect(() => exitOnBootstrapError('video-worker', exit)('texto')).toThrow('exit 1');
    expect(stderr).toHaveBeenCalledWith('[video-worker] falha ao iniciar: texto\n');
  });

  it('usa a mensagem quando o erro não tem stack', () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = new Error('sem stack');
    error.stack = undefined;
    const exit = jest.fn((): never => {
      throw new Error('exit');
    });

    expect(() => exitOnBootstrapError('x', exit)(error)).toThrow('exit');
    expect(stderr).toHaveBeenCalledWith('[x] falha ao iniciar: sem stack\n');
  });

  it('por padrão encerra via process.exit(1)', () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit ${String(code)}`);
    });

    expect(() => exitOnBootstrapError('x')(new Error('boom'))).toThrow('process.exit 1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
