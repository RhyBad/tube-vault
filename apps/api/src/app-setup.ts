/**
 * Shared HTTP-app configuration (P8): ONE place builds the express-level
 * middleware stack so main.ts and every e2e bootstrap run the SAME pipeline
 * (the notifications e2e used to run a DIFFERENT stack than prod — bootstrap
 * drift the P8 audit flagged).
 *
 * Callers create the app with `{ bodyParser: false }`; the json() here
 * replaces Nest's built-in parser with a 2mb limit — the P8 cookie-jar import
 * (PUT /api/session) can exceed express's 100kb default; the zod schema still
 * caps the cookies FIELD at 1MiB (400), 2mb is just headroom.
 */
import type { INestApplication } from '@nestjs/common';
import { json, type Express } from 'express';
import type { NextFunction, Request, Response } from 'express';

/** Fixed, secret-free error bodies for the express body-parsing layer. */
const MALFORMED_JSON_BODY = { message: 'malformed JSON body' } as const;
const BODY_TOO_LARGE = { message: 'request body too large' } as const;

export function configureApp(app: INestApplication): void {
  // P9 (the P4 auth.controller SEAM): behind the same-origin nginx proxy every
  // request arrives from the proxy container's IP, which would collapse the
  // per-IP login rate limiter into ONE global bucket (a remote flood locks the
  // owner out). Trust X-Forwarded-For ONLY from loopback/private hops — the
  // nginx container (docker network) and localhost dev — so a direct PUBLIC
  // client can't spoof its way into fresh buckets, while proxied clients get
  // their real per-IP buckets back.
  //
  // SECURITY SCOPE (P9 audit): 'uniquelocal' makes EVERY RFC1918 client a
  // trusted hop, so this grant is only safe because the deployment closes the
  // direct-LAN route: nginx OVERWRITES X-Forwarded-For with $remote_addr
  // (apps/web/nginx.conf — pinned by its conf test) and the compose stack
  // binds the api port to 127.0.0.1 (docker-compose.yml), leaving nginx and
  // host-local debugging as the only ways in. Deploying the api DIRECTLY on a
  // LAN without that proxy would let any private-address client forge XFF —
  // narrow this to the proxy's address (or drop 'uniquelocal') in that case.
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', ['loopback', 'uniquelocal']);
  app.use(json({ limit: '2mb' }));
  // SECURITY (P8): body-parser failures throw BEFORE Nest's exception layer.
  // Left unhandled, the JSON SyntaxError's message reaches the response body —
  // and V8's JSON.parse message QUOTES a snippet of the raw input, i.e. raw
  // cookie bytes on a malformed PUT /api/session (empirically confirmed).
  // Map body-parser errors to FIXED shapes; NEVER serialize or log the error
  // object (err.message quotes the input and err.body carries the whole raw
  // request body).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type =
      typeof err === 'object' && err !== null && 'type' in err
        ? (err as { type?: unknown }).type
        : undefined;
    if (type === 'entity.too.large') {
      res.status(413).json(BODY_TOO_LARGE);
      return;
    }
    if (type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json(MALFORMED_JSON_BODY);
      return;
    }
    next(err);
  });
  app.setGlobalPrefix('api');
}
