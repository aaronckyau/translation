export function normalizeBasePath(value: string): string {
  if (!value || value === '/') return '/';
  const path = value.endsWith('/') ? value : `${value}/`;
  if (!/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(path)) throw new Error('APP_BASE_PATH must be an absolute path with simple path segments.');
  return path;
}

export function publicPath(base: string, resource: string): string {
  return `${normalizeBasePath(base)}${resource.replace(/^\/+/, '')}`;
}
