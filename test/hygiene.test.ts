import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

test('publish allowlist excludes working boards, audits, tests, and scratch files', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files?: string[] };
  assert.ok(Array.isArray(pkg.files));
  for (const required of ['bin/', 'src/', 'spec/', 'templates/', 'worker/src/', 'worker/tsconfig.json', 'wrangler.jsonc']) {
    assert.ok(pkg.files.includes(required), `${required} remains publishable`);
  }
  for (const unsafe of ['.', '.botflow/', 'worker/', 'audit/', 'test/']) {
    assert.equal(pkg.files.includes(unsafe), false, `${unsafe} must not broaden the package`);
  }
});

test('common local secret and package-artifact names are ignored', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const pattern of ['.dev.vars', '.dev.vars.*', '.env', '.env.*', '*.tgz']) {
    assert.ok(ignore.includes(pattern), `${pattern} is ignored`);
  }
  assert.ok(ignore.includes('!.dev.vars.example'));
  assert.ok(ignore.includes('!.env.example'));
});
