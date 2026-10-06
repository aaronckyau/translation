type ApiKeyEnvironment = { GEMINI_API_KEY?: string; GOOGLE_API_KEY?: string };

// Empty template entries must not mask a configured key in a lower-priority file.
export function resolveApiKey(...sources: ApiKeyEnvironment[]): string {
  for (const source of sources) {
    for (const value of [source.GEMINI_API_KEY, source.GOOGLE_API_KEY]) {
      if (value?.trim()) return value.trim();
    }
  }
  return '';
}

export function validateNetworkAccessCode(host: string, accessCode: string, allowShortCode = false): void {
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return;
  const minimumLength = allowShortCode ? 1 : 16;
  if (!accessCode.trim() || accessCode.length < minimumLength) {
    throw new Error(`Network hosting requires APP_ACCESS_CODE with at least ${minimumLength} characters.`);
  }
}
