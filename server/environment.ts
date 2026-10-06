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
