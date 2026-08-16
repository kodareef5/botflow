#!/usr/bin/env node
// Thin shim so `npm link`/npx get a bin while the source stays native TS.
import '../src/cli/botflow.ts';
