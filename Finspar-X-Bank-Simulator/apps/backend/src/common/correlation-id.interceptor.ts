import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { CORRELATION_HEADER, runWithCorrelationId, sanitiseCorrelationId } from './correlation';

/**
 * Binds a correlation id to every request (ENHANCEMENTS.md §3).
 *
 * Reuses the caller's `x-correlation-id` when it supplies one — so a trace can
 * begin in the browser and span the whole hop chain — and mints one otherwise.
 * Echoes it back on the response so the client can quote it in a support
 * request, and so the analyst UI can link a verdict to its trace.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const id = sanitiseCorrelationId(req.headers[CORRELATION_HEADER]);
    res.setHeader(CORRELATION_HEADER, id);

    // The whole downstream handler runs inside the async context, so anything it
    // awaits — including the Sentinel call — can read the id without being passed it.
    return runWithCorrelationId(id, () => next.handle());
  }
}
