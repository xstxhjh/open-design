import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const targets = [
  path.join(rootDir, 'e2e', '.od-data'),
  path.join(rootDir, 'e2e', 'test-results'),
  path.join(rootDir, 'e2e', 'reports', 'test-results'),
  path.join(rootDir, 'e2e', 'reports', 'html'),
  path.join(rootDir, 'e2e', 'reports', 'playwright-html-report'),
  path.join(rootDir, 'e2e', 'reports', 'results.json'),
  path.join(rootDir, 'e2e', 'reports', 'junit.xml'),
  path.join(rootDir, 'e2e', 'reports', 'latest.md'),
  path.join(rootDir, 'e2e', '.DS_Store'),
];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
}

await mkdir(path.join(rootDir, 'e2e', 'reports'), { recursive: true });

// Recreate runtime roots so local inspection stays predictable even before
// Playwright or the daemon materializes them.
await mkdir(path.join(rootDir, 'e2e', '.od-data'), { recursive: true });
await mkdir(path.join(rootDir, 'e2e', 'reports', 'test-results'), {
  recursive: true,
});

// Best-effort removal of accidental empty directories directly under the
// test data root. This keeps old project ids from piling up across runs.
const projectsRoot = path.join(rootDir, 'e2e', '.od-data', 'projects');
try {
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        rm(path.join(projectsRoot, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );
} catch (error) {
  // It's fine if the daemon hasn't created the projects root yet.
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    // Missing roots are expected before the first daemon boot.
  } else {
    console.warn('Failed to clean stale e2e project dirs:', error);
  }
}
