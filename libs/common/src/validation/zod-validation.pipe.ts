import type { PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CommonErrors } from '../errors/catalog/common.errors';

export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Valida (e transforma) body/query/params com um schema zod. Inválido → `400 X0001 VALIDATION`
 * com `metadata.fields = [{ field, message }]`.
 *
 * `@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput`
 */
@Injectable()
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw CommonErrors.VALIDATION(toIssues(result.error));
  }
}

export function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(raiz)',
    message: issue.message,
  }));
}
