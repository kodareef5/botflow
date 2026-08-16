// `botflow serve`: read-only local web view. Files stay the source of truth:
// every /api/data request re-reads the board from disk (fast at repo scale),
// so the page is never stale and there is nothing to invalidate.

import { createServer, type Server } from 'node:http';

import { analyze } from '../core/analyze.ts';
import { loadTree } from '../core/load.ts';
import { viewerData, viewerHtml } from './page.ts';

export const DEFAULT_PORT = 4666;

export interface RunningViewer {
  server: Server;
  port: number;
  url: string;
}

export function serveBoard(root: string, port: number): Promise<RunningViewer> {
  const server = createServer((req, res) => {
    try {
      const url = req.url ?? '/';
      if (url === '/' || url === '/index.html') {
        const tree = loadTree(root);
        const name = tree.boards.get('.')!.board.config.name;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(viewerHtml(null, { live: true, title: name }));
      } else if (url === '/api/data') {
        const tree = loadTree(root);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(viewerData(tree, analyze(tree))));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`botflow serve error: ${(err as Error).message}`);
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    // Local-only by design; the hosted story is the worker/ manager.
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port;
      resolvePromise({ server, port: actual, url: `http://127.0.0.1:${actual}/` });
    });
  });
}
