import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { toHttpError } from './errors';
import type { AuthedRequest } from './guard';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    const { status, body } = toHttpError(exception, req.requestId);
    if (status >= 500) {
      // include the underlying driver error (Drizzle wraps it as `cause`): that is where the real reason is
      const causes: string[] = [];
      for (
        let c: unknown = (exception as { cause?: unknown } | null)?.cause;
        c && causes.length < 4;
        c = (c as { cause?: unknown }).cause
      ) {
        causes.push(
          c instanceof Error ? `${(c as { code?: string }).code ?? ''} ${c.message}` : String(c),
        );
      }
      this.log.error(
        `${req.method} ${req.url} [${req.requestId}]: ${exception instanceof Error ? exception.message.slice(0, 160) : String(exception)}${causes.length ? ` <- ${causes.join(' <- ')}` : ''}`,
      );
    }
    const retry = (body.error.details as { retryAfterSeconds?: number } | undefined)
      ?.retryAfterSeconds;
    if (status === 429 && retry) res.setHeader('Retry-After', String(retry));
    res.status(status).json(body);
  }
}
