/**
 * The `app://` handler that serves the Next.js static export in production.
 * See docs/spec-stack.md §4 for why this beats `loadFile()`/`file://` or a
 * real HTTP server.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = 'app://local';

const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

/** MUST run at module top level, before `app.whenReady()`, exactly once. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

async function fetchFile(absolutePath: string): Promise<Response | null> {
  try {
    return await net.fetch(pathToFileURL(absolutePath).toString());
  } catch {
    return null;
  }
}

/** Serves `outDir` (the Next.js `out/` export) over `app://local/...`. */
export function serveExport(outDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const target = path.join(outDir, rel);
    const relCheck = path.relative(outDir, target);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      return new Response('Forbidden', { status: 403 });
    }

    let res = await fetchFile(target);
    if (!res || res.status === 404) {
      res = await fetchFile(path.join(outDir, '404.html'));
    }
    if (!res) {
      // `out/` hasn't been built yet (e.g. before W3's `next build` runs).
      return new Response(
        'File Warper: no build output found. Run `npm run build:renderer`.',
        {
          status: 404,
          headers: { 'Content-Security-Policy': CSP },
        },
      );
    }

    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}
