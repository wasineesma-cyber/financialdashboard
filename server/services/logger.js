import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dir, '..', 'logs');
try { mkdirSync(logsDir, { recursive: true }); } catch {}

const logStream = createWriteStream(join(logsDir, 'audit.log'), { flags: 'a' });

function write(level, event, data = {}) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  });
  logStream.write(entry + '\n');
  if (level === 'ERROR') console.error(entry);
  else console.log(entry);
}

export const logger = {
  info: (event, data) => write('INFO', event, data),
  warn: (event, data) => write('WARN', event, data),
  error: (event, data) => write('ERROR', event, data),
  audit: (event, data) => write('AUDIT', event, data),
};
