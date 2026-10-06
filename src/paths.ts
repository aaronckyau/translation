import { publicPath } from '../shared/paths';

export const appPath = (resource: string): string => publicPath(import.meta.env.BASE_URL, resource);
