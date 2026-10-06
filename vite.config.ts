import { defineConfig } from 'vite';
import { normalizeBasePath } from './shared/paths.ts';

export default defineConfig({
  base: normalizeBasePath(process.env.APP_BASE_PATH || '/'),
  server: { allowedHosts: ['localhost', '127.0.0.1'] },
  build: { sourcemap: false },
});
