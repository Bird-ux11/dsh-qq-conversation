import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Synchronous atomic commit: acknowledge an inbound message only after this returns. */
export class StateFile {
  constructor(file) { this.file = file; }
  read() {
    if (!existsSync(this.file)) return null;
    const value = JSON.parse(readFileSync(this.file, 'utf8'));
    if (value.version !== 1) throw new Error('Unsupported conversation state file');
    return value;
  }
  write(value) {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ ...value, version: 1 }), { mode: 0o600, flag: 'wx' });
      const fd = openSync(temp, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file);
    } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
