import cors from '@fastify/cors'
import type { FastifyInstance } from 'fastify'

/**
 * Registers CORS on the hub server, restricted to exactly one origin.
 *
 * The origin check is a callback (not a static string) so `@fastify/cors`
 * echoes back the caller's `Origin` header only when it equals `webOrigin`,
 * and — because the allowed value now depends on the request — automatically
 * adds `Vary: Origin` to every response. That header matters here: without
 * it, a shared cache (a CDN, a corporate proxy) that saw an allowed origin's
 * response could legally replay it to a different, disallowed origin.
 *
 * `webOrigin` is never widened to `'*'`: a request from any origin other
 * than the configured one gets no `Access-Control-Allow-Origin` header at
 * all, so the browser discards the response.
 *
 * When `webOrigin` is undefined (no `WEB_ORIGIN` configured — the local
 * single-machine dev/desktop case), this registers nothing. Registering CORS
 * with no configured origin would either open the hub to every website or
 * require a fallback default; both are wrong for an endpoint whose real
 * identity check is the auth hook, and a hub with no configured origin
 * should not be reachable cross-origin from anywhere at all.
 */
export function registerHubCors(server: FastifyInstance, webOrigin: string | undefined): void {
  if (!webOrigin) return

  server.register(cors, {
    origin: (requestOrigin, callback) => {
      callback(null, requestOrigin === webOrigin)
    },
    credentials: true,
  })
}
