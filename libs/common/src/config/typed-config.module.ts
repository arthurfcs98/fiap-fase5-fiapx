import type { DynamicModule, InjectionToken } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { z } from 'zod';
import { loadConfig } from './load-config';

export interface TypedConfigModuleOptions<S extends z.ZodObject> {
  /** Token de injeção da configuração validada (ex.: `API_CONFIG`). */
  token: InjectionToken;
  schema: S;
  env?: NodeJS.ProcessEnv;
}

/**
 * Módulo global que valida a configuração com zod no boot (fail fast) e a expõe por token:
 * `constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}`.
 */
@Module({})
export class TypedConfigModule {
  static forRoot<S extends z.ZodObject>(options: TypedConfigModuleOptions<S>): DynamicModule {
    return {
      module: TypedConfigModule,
      global: true,
      providers: [
        {
          provide: options.token,
          useFactory: () => loadConfig(options.schema, options.env ?? process.env),
        },
      ],
      exports: [options.token],
    };
  }
}
