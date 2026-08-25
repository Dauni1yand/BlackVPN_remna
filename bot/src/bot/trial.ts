import type Database from 'better-sqlite3';
import type { Context } from 'grammy';

import { commitTrialSlot, getTrialGrant, releaseTrialSlot, reserveTrialSlot } from '../lib/db.js';
import type { RemnawaveClient } from '../remnawave/client.js';
import type { BotConfig } from './config.js';
import { backToMenu } from './keyboards.js';

export interface TrialDeps {
  db: Database.Database;
  remnawave: RemnawaveClient;
  config: BotConfig;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export async function handleTrial(ctx: Context, deps: TrialDeps): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const existing = getTrialGrant(deps.db, telegramId);

  if (existing?.status === 'active') {
    await ctx.reply(
      `Пробная подписка уже была активирована (до ${formatDate(existing.expires_at)}).\n\n` +
        `Ссылка для подключения:\n\`${existing.subscription_url}\``,
      { parse_mode: 'Markdown', reply_markup: backToMenu() },
    );
    return;
  }

  if (existing?.status === 'pending') {
    await ctx.reply('Запрос уже обрабатывается, подождите немного.', { reply_markup: backToMenu() });
    return;
  }

  if (!reserveTrialSlot(deps.db, telegramId)) {
    // Lost a race against a concurrent request for the same user.
    await ctx.reply('Пробная подписка уже была использована.', { reply_markup: backToMenu() });
    return;
  }

  try {
    const username = `tg_${telegramId}`;
    const expireAt = new Date(Date.now() + deps.config.trialDays * 24 * 60 * 60 * 1000).toISOString();

    const user = await deps.remnawave.createUser({
      username,
      expireAt,
      trafficLimitBytes: deps.config.trialTrafficBytes,
      trafficLimitStrategy: 'NO_RESET',
      telegramId,
      activeInternalSquads: [deps.config.internalSquadUuid],
      tag: 'TRIAL',
    });

    commitTrialSlot(deps.db, telegramId, {
      username: user.username,
      userId: user.id,
      subscriptionUrl: user.subscriptionUrl,
      expiresAt: user.expireAt,
    });

    const trafficGb = Math.round(deps.config.trialTrafficBytes / 1024 ** 3);

    await ctx.reply(
      `🎁 Пробная подписка активирована на ${deps.config.trialDays} дн. (до ${trafficGb} ГБ трафика).\n\n` +
        `Ссылка для подключения — вставь её в Happy, v2RayTun или похожее приложение:\n` +
        `\`${user.subscriptionUrl}\`\n\n` +
        `Действует до ${formatDate(user.expireAt)}.`,
      { parse_mode: 'Markdown', reply_markup: backToMenu() },
    );
  } catch (error) {
    releaseTrialSlot(deps.db, telegramId);
    console.error('Trial creation failed:', error);
    await ctx.reply('Не получилось выдать пробную подписку, попробуйте чуть позже.', {
      reply_markup: backToMenu(),
    });
  }
}
