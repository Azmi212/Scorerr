import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbidden = [
  'SCORERR_MASTER_KEY',
  'RADARR_API_KEY',
  'SEERR_API_KEY',
  'JELLYSEERR_API_KEY',
  '/__design-system',
  'valeur-de-demonstration',
];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!['.html', '.js', '.css', '.map'].includes(extname(entry.name))) continue;
    const contents = await readFile(path, 'utf8');
    const match = forbidden.find((value) => contents.includes(value));
    if (match) throw new Error(`Forbidden production marker ${match} found in ${path}`);
  }
}

await visit(fileURLToPath(new URL('../dist', import.meta.url)));
