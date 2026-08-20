import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeTerminalText } from '../src/cli/terminal.ts';

test('terminal output strips C0, DEL, and C1 controls on stdout and stderr paths', () => {
  assert.equal(
    sanitizeTerminalText('safe\tline\nrewritten\r\x1b[2Jred\x7f\u009b[31mtext\u009c\u202eevil\u2066'),
    'safe\tline\nrewritten[2Jred[31mtextevil',
  );
});
