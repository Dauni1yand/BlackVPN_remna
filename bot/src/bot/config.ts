import { readFileSync } from 'node:fs';

import { optionalEnv, requireEnv } from '../lib/env.js';

interface BootstrapSummary {
  apiToken?: { token?: string };
  internalSquad?: { uuid?: string };
}

function loadBootstrapSummary(path: string): BootstrapSummary {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BootstrapSummary;
  } catch {
    return {};
  }
}

export interface BotConfig {
  botToken: string;
  adminTelegramIds: Set<number>;
  panelUrl: string;
  apiToken: string;
  internalSquadUuid: string;
  trialDays: number;
  trialTrafficBytes: number;
  dbPath: string;
}

// Reuses whatever `npm run bootstrap` already produced (API token, internal
// squad uuid) instead of making the operator copy them into the bot's own
// .env by hand — same pattern as bot/src/cli/add-node.ts. Explicit env vars
// still win if set.
export function loadBotConfig(): BotConfig {
  const botToken = requireEnv('BOT_TOKEN');
  const panelUrl = optionalEnv('PANEL_URL', 'http://127.0.0.1:3000');
  const bootstrapFile = optionalEnv('BOOTSTRAP_SUMMARY_FILE', './bootstrap-summary.json');
  const summary = loadBootstrapSummary(bootstrapFile);

  const apiToken = process.env.API_TOKEN || summary.apiToken?.token;
  if (!apiToken) {
    throw new Error(
      `No Remnawave API token. Set API_TOKEN, or run "npm run bootstrap" first ` +
        `(expected its output at ${bootstrapFile}).`,
    );
  }

  const internalSquadUuid = process.env.INTERNAL_SQUAD_UUID || summary.internalSquad?.uuid;
  if (!internalSquadUuid) {
    throw new Error(
      `No internal squad uuid. Set INTERNAL_SQUAD_UUID, or run "npm run bootstrap" first ` +
        `(expected its output at ${bootstrapFile}).`,
    );
  }

  const adminTelegramIds = new Set(
    optionalEnv('ADMIN_TELEGRAM_IDS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );

  const trialDays = Number(optionalEnv('TRIAL_DAYS', '3'));
  const trialTrafficGb = Number(optionalEnv('TRIAL_TRAFFIC_GB', '10'));

  return {
    botToken,
    adminTelegramIds,
    panelUrl,
    apiToken,
    internalSquadUuid,
    trialDays,
    trialTrafficBytes: trialTrafficGb * 1024 ** 3,
    dbPath: optionalEnv('DB_PATH', './data/bot.sqlite3'),
  };
}
