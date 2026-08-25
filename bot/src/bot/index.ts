import 'dotenv/config';
import { Bot } from 'grammy';

import { openDb } from '../lib/db.js';
import { RemnawaveClient } from '../remnawave/client.js';
import { loadBotConfig } from './config.js';
import {
  OPEN_ADMIN_TEXT,
  OPEN_MENU_TEXT,
  adminMenu,
  backToAdmin,
  backToMenu,
  mainMenu,
  mainReplyKeyboard,
} from './keyboards.js';
import { handleTrial } from './trial.js';

const config = loadBotConfig();
const db = openDb(config.dbPath);
const remnawave = new RemnawaveClient(config.panelUrl, config.apiToken);

const bot = new Bot(config.botToken);

function isAdmin(telegramId: number | undefined): boolean {
  return telegramId !== undefined && config.adminTelegramIds.has(telegramId);
}

const WELCOME_TEXT =
  'Добро пожаловать в BlackVPN 👋\n\n' +
  'Здесь можно оформить платную подписку и подключиться за пару минут ' +
  'через Happy, v2RayTun и похожие приложения.\n\n' +
  'Нажмите кнопку ниже, чтобы открыть меню.';

// The first message a user sends a bot is unavoidably /start (Telegram
// shows it as a "START" button itself before any chat history exists —
// that's already a button tap, not typed text). What matters is what
// happens after: from here on the user never needs a command again, just
// the persistent buttons below the input.
bot.command('start', async (ctx) => {
  await ctx.reply(WELCOME_TEXT, { reply_markup: mainReplyKeyboard(isAdmin(ctx.from?.id)) });
});

bot.hears(OPEN_MENU_TEXT, async (ctx) => {
  await ctx.reply('Выберите действие:', { reply_markup: mainMenu() });
});

bot.hears(OPEN_ADMIN_TEXT, async (ctx) => {
  if (!isAdmin(ctx.from?.id)) return;
  await ctx.reply('Админ-панель:', { reply_markup: adminMenu() });
});

bot.callbackQuery('nav:main', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Выберите действие:', { reply_markup: mainMenu() });
});

bot.callbackQuery('nav:admin', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx.from?.id)) return;
  await ctx.editMessageText('Админ-панель:', { reply_markup: adminMenu() });
});

bot.callbackQuery('menu:trial', async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleTrial(ctx, { db, remnawave, config });
});

// Everything else in the spec that isn't built yet: same wiring (menu
// buttons, callback data, admin gating), placeholder text instead of logic.
const STUBS: Record<string, string> = {
  'menu:buy': '🛒 Покупка подписки скоро появится здесь.',
  'menu:current': '📱 Раздел «Текущая подписка» в разработке.',
  'menu:support': '🆘 Поддержка скоро будет доступна прямо в боте.',
  'menu:help': '🔧 Инструкции по подключению скоро появятся здесь.',
  'menu:about': 'ℹ️ О сервисе — раздел в разработке.',
  'admin:users': '👥 Просмотр пользователей — в разработке.',
  'admin:nodes': '🌍 Добавление и удаление нод — в разработке.',
  'admin:stats': '📊 Статистика по серверам — в разработке.',
  'admin:tickets': '🎫 Ответы на тикеты — в разработке.',
  'admin:pricing': '💰 Редактирование цен и сроков — в разработке.',
};

for (const [data, text] of Object.entries(STUBS)) {
  bot.callbackQuery(data, async (ctx) => {
    const isAdminSection = data.startsWith('admin:');
    if (isAdminSection && !isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { reply_markup: isAdminSection ? backToAdmin() : backToMenu() });
  });
}

bot.on('message:text', async (ctx) => {
  await ctx.reply(`Не понимаю эту команду. Нажмите «${OPEN_MENU_TEXT}» внизу.`, {
    reply_markup: mainReplyKeyboard(isAdmin(ctx.from?.id)),
  });
});

bot.catch((err) => {
  console.error('Bot error:', err.error);
});

bot.start();
console.log('Bot started (long polling)');
