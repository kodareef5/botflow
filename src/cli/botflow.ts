// Executable entry: `node src/cli/botflow.ts …` or via bin/botflow.js.
import process from 'node:process';
import { main } from './main.ts';

main(process.argv.slice(2));
