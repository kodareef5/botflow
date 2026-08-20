/** Remove terminal and bidi-format controls from any human-facing stream.
 *  Keep only tab and newline; carriage return can rewrite a line. */
export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function writeStderr(value: string): void {
  const safe = sanitizeTerminalText(value);
  void process.stderr.write(safe.endsWith('\n') ? safe : safe + '\n');
}
