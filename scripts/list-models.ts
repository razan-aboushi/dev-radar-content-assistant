/**
 * Prints the models your configured provider can actually run today.
 *
 *   npm run models
 *
 * This exists because hosted model IDs are retired on a few months' notice and
 * the failure mode is a bare 404. Two of the defaults originally shipped in
 * this project were already dead when they were written down. When generation
 * starts failing with "model not found", run this and put a live name in
 * OPENAI_MODEL.
 */
import { config, FREE_PROVIDER_PRESETS } from '../src/config';

interface ModelList {
  data?: Array<{ id?: string; name?: string }>;
  models?: Array<{ id?: string; name?: string } | string>;
  error?: { message?: string };
}

async function main(): Promise<void> {
  if (config.ai.provider === 'none') {
    process.stdout.write(
      'AI_PROVIDER is "none", so there is nothing to list.\n' +
        `Set one of: ${Object.keys(FREE_PROVIDER_PRESETS).join(', ')}, ollama, openai-compatible\n`,
    );
    return;
  }

  if (config.ai.provider === 'ollama') {
    const response = await fetch(`${config.ai.ollamaBaseUrl}/api/tags`);
    if (!response.ok) {
      process.stderr.write(`Ollama is not reachable at ${config.ai.ollamaBaseUrl}\n`);
      process.exitCode = 1;
      return;
    }
    const parsed = (await response.json()) as { models?: Array<{ name: string }> };
    const names = (parsed.models ?? []).map((m) => m.name).sort();
    process.stdout.write(`Ollama models at ${config.ai.ollamaBaseUrl}:\n`);
    for (const name of names) {
      process.stdout.write(`  ${name}${name === config.ai.ollamaModel ? '   <- configured' : ''}\n`);
    }
    if (names.length === 0) process.stdout.write('  (none pulled yet — try: ollama pull llama3.1:8b)\n');
    return;
  }

  if (!config.ai.openaiApiKey) {
    process.stderr.write(
      'No API key. Set OPENAI_API_KEY in .env.\n' +
        `Get a free one: ${FREE_PROVIDER_PRESETS[config.ai.presetName]?.keyUrl ?? '(see the README)'}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const url = `${config.ai.openaiBaseUrl}/models`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.ai.openaiApiKey}` },
  });
  const text = await response.text();

  if (!response.ok) {
    process.stderr.write(
      response.status === 401 || response.status === 403
        ? `The key was rejected by ${config.ai.presetName}. Check OPENAI_API_KEY.\n`
        : `HTTP ${response.status} from ${url}\n${text.slice(0, 300)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let parsed: ModelList;
  try {
    parsed = JSON.parse(text) as ModelList;
  } catch {
    process.stderr.write(`${url} did not return JSON.\n`);
    process.exitCode = 1;
    return;
  }

  const entries = parsed.data ?? parsed.models ?? [];
  const names = entries
    .map((entry) => (typeof entry === 'string' ? entry : (entry.id ?? entry.name ?? '')))
    .filter(Boolean)
    .sort();

  process.stdout.write(`${names.length} model(s) available on ${config.ai.presetName}:\n`);
  for (const name of names) {
    process.stdout.write(`  ${name}${name === config.ai.openaiModel ? '   <- configured' : ''}\n`);
  }

  if (!names.includes(config.ai.openaiModel)) {
    process.stdout.write(
      `\nWARNING: the configured model "${config.ai.openaiModel}" is not in that list.\n` +
        'Generation will fail with a 404. Put one of the names above in OPENAI_MODEL.\n',
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
