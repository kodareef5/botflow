// `botflow serve`: read-only local web view. Files stay the source of truth:
// every /api/data request re-reads the board from disk (fast at repo scale),
// so the page is never stale and there is nothing to invalidate.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import { analyze } from '../core/analyze.ts';
import { loadTree } from '../core/load.ts';
import { viewerData, viewerHtml } from './page.ts';

export const DEFAULT_PORT = 4666;

// The server binds loopback but would still answer a DNS-rebinding site that
// points its domain at 127.0.0.1: the browser treats it as same-origin and
// could read the whole board tree via /api/data. Only answer loopback Hosts.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function hostAllowed(host: string | undefined): boolean {
  if (host === undefined) return false;
  const match = host.startsWith('[')
    ? /^(\[[0-9a-f:]+\])(?::([0-9]{1,5}))?$/i.exec(host)
    : /^([^:]+)(?::([0-9]{1,5}))?$/.exec(host);
  if (match === null || (match[2] !== undefined && Number(match[2]) > 65_535)) return false;
  return LOOPBACK_HOSTS.has(match[1]!.toLowerCase());
}

export interface RunningViewer {
  server: Server;
  port: number;
  url: string;
}

export function serveBoard(root: string, port: number): Promise<RunningViewer> {
  const capabilityPath = `/${randomBytes(24).toString('hex')}/`;
  const server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { ...BASE_HEADERS, 'content-type': 'text/plain' });
      res.end('forbidden: untrusted host');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const head = req.method === 'HEAD';
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!pathname.startsWith(capabilityPath)) {
        res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const url = `/${pathname.slice(capabilityPath.length)}`;
      if (url === '/' || url === '/index.html') {
        const tree = loadTree(root);
        const name = tree.boards.get('.')!.board.config.name;
        res.writeHead(200, {
          ...BASE_HEADERS,
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'content-type': 'text/html; charset=utf-8',
        });
        res.end(head ? undefined : viewerHtml(null, { live: true, title: name }));
      } else if (url === '/api/data') {
        const tree = loadTree(root);
        res.writeHead(200, { ...BASE_HEADERS, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'content-type': 'application/json' });
        res.end(head ? undefined : JSON.stringify(viewerData(tree, analyze(tree))));
      } else {
        res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'text/plain' });
        res.end('not found');
      }
    } catch (err) {
      res.writeHead(500, { ...BASE_HEADERS, 'content-type': 'text/plain' });
      res.end(`botflow serve error: ${(err as Error).message}`);
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    // Local-only by design; the hosted story is the worker/ manager.
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port;
      resolvePromise({ server, port: actual, url: `http://127.0.0.1:${actual}${capabilityPath}` });
    });
  });
}
