import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Forked workers, started with --expose-gc so a spec can force a collection and read the heap.
    // The worker_threads pool cannot take V8 flags per worker.
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
});
