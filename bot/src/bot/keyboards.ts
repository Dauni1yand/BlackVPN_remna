import { InlineKeyboard, Keyboard } from 'grammy';

// The persistent buttons under the message input — this is the "button,
// not /start" entry point: after the very first /start, the user drives
// everything from these two buttons instead of typing commands.
export const OPEN_MENU_TEXT = '🏠 Меню';
export const OPEN_ADMIN_TEXT = '⚙️ Админ-панель';

export function mainReplyKeyboard(isAdmin: boolean): Keyboard {
  const kb = new Keyboard().text(OPEN_MENU_TEXT);
  if (isAdmin) kb.text(OPEN_ADMIN_TEXT);
  return kb.resized();
}

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🛒 Купить подписку', 'menu:buy')
    .text('📱 Текущая подписка', 'menu:current')
    .row()
    .text('🎁 Пробная подписка', 'menu:trial')
    .text('🆘 Поддержка', 'menu:support')
    .row()
    .text('🔧 Помощь в подключении', 'menu:help')
    .text('ℹ️ О сервисе', 'menu:about')
    .row();
}

export function adminMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('👥 Пользователи', 'admin:users')
    .text('🌍 Ноды', 'admin:nodes')
    .row()
    .text('📊 Статистика', 'admin:stats')
    .text('🎫 Тикеты', 'admin:tickets')
    .row()
    .text('💰 Цены и сроки', 'admin:pricing')
    .row();
}

export function backToMenu(): InlineKeyboard {
  return new InlineKeyboard().text('« Назад в меню', 'nav:main');
}

export function backToAdmin(): InlineKeyboard {
  return new InlineKeyboard().text('« Назад в админ-панель', 'nav:admin');
}
