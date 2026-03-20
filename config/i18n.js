// ═══════════════════════════════════════════════════════
//  Server-side i18n translations
// ═══════════════════════════════════════════════════════

const TRANSLATIONS = {
  ru: {
    // ── Common errors ──
    'err.missing_fields': 'Не все поля заполнены',
    'err.player_not_found': 'Игрок не найден',
    'err.conflict': 'Конфликт — попробуйте снова',
    'err.db_unavailable': 'Сервер временно недоступен, попробуй через минуту',
    'err.forbidden': 'Доступ запрещён',
    'err.unknown_action': 'Неизвестное действие',

    // ── Distance / position ──
    'err.too_far': 'Слишком далеко ({distance}м > {radius}м)',
    'err.too_far_short': 'Слишком далеко',
    'err.too_far_closer': 'Слишком далеко! Подойди ближе ({radius}м)',
    'err.invalid_coords': 'Некорректные координаты',
    'err.coords_required': 'Координаты игрока не переданы',
    'err.gps_not_ready': 'GPS не готов',
    'err.approach': 'Подойди ближе ({distance}м > {radius}м)',

    // ── Player ──
    'err.cant_attack_self': 'Нельзя атаковать себя',
    'err.player_shielded': 'Игрок под защитой',
    'err.username_length': 'Ник должен быть 3-16 символов',
    'err.username_chars': 'Только буквы, цифры и _',
    'err.username_taken': 'Этот ник уже занят',
    'err.not_enough_diamonds': 'Недостаточно алмазов (нужно {cost} 💎)',
    'err.not_enough_diamonds_short': 'Недостаточно алмазов',
    'err.not_enough_coins': 'Не хватает монет (нужно {cost})',
    'err.not_enough_ether': 'Недостаточно эфира',
    'err.not_enough_crystals': 'Нужно {cost} ✨',
    'err.respawn_wait': 'Возрождение через {seconds} сек',
    'err.already_claimed': 'Уже получено',
    'err.dead': 'Вы мертвы!',

    // ── HQ ──
    'err.hq_exists': 'Штаб уже установлен',
    'err.no_free_cells': 'Нет свободных клеток рядом',
    'err.bonus_claimed': 'Бонус уже получен',
    'err.hq_not_found': 'Штаб не найден',
    'err.hq_max_level': 'Штаб уже максимального уровня',
    'err.need_hq_first': 'Сначала установите штаб',

    // ── Mine ──
    'err.cell_occupied': 'Клетка уже занята',
    'err.cant_attack_own_mine': 'Нельзя атаковать свою шахту',
    'err.mine_already_attacked': 'Шахта уже атакована',
    'err.mine_inactive': 'Шахта неактивна',
    'err.mine_not_attacked': 'Шахта не атакуется',
    'err.not_attacking_mine': 'Вы не атакуете эту шахту',
    'err.attack_not_finished': 'Атака ещё не завершена',
    'err.already_attacking': 'Вы уже атакуете другую шахту',
    'err.mine_not_yours': 'Не ваша шахта',
    'err.mine_not_burning': 'Шахта не горит',
    'err.mine_burned': 'Шахта сгорела — слишком поздно',
    'err.mine_unavailable': 'Шахта недоступна для атаки',
    'err.upgrade_in_progress': 'Апгрейд ещё идёт ({seconds} сек)',
    'err.target_level_higher': 'targetLevel должен быть выше текущего уровня',

    // ── Items ──
    'err.item_not_found': 'Предмет не найден',
    'err.unequip_first': 'Сначала снимите предмет',
    'err.item_on_market': 'Предмет на маркете',
    'err.max_level': 'Максимальный уровень',
    'err.need_10_items': 'Нужно ровно 10 предметов',
    'err.items_not_found': 'Некоторые предметы не найдены или не ваши',
    'err.same_rarity': 'Все предметы должны быть одной редкости',
    'err.unequip_crafting': 'Снимите экипированные предметы',
    'err.legendary_no_craft': 'Легендарные предметы нельзя крафтить',
    'err.no_items_to_sell': 'Нет предметов для продажи',
    'err.max_200_items': 'Максимум 200 предметов за раз',
    'err.need_diamonds': 'Нужно {cost} 💎',

    // ── Market ──
    'err.listing_not_found': 'Лот не найден или истёк',
    'err.not_your_parcel': 'Это не ваша посылка',

    // ── Clan ──
    'err.clan_hq_exists': 'У вас уже есть штаб клана',
    'err.already_in_clan': 'Вы уже в клане',
    'err.not_in_clan': 'Вы не в клане',
    'err.build_clan_hq_first': 'Сначала постройте штаб клана',
    'err.clan_name_taken': 'Название клана уже занято',
    'err.clan_name_length': 'Название: 3-20 символов',
    'err.clan_symbol_length': 'Символ: один emoji',
    'err.clan_color_invalid': 'Недопустимый цвет',
    'err.clan_not_found': 'Клан не найден',
    'err.clan_min_level': 'Мин. уровень: {level}',
    'err.clan_full': 'Клан переполнен',
    'err.leader_cant_leave': 'Лидер не может покинуть клан. Сначала передайте лидерство.',
    'err.invalid_amount': 'Некорректная сумма',
    'err.leader_or_officer': 'Только лидер или офицер',
    'err.leader_only': 'Только лидер может менять роли',
    'err.leader_only_edit': 'Только лидер может редактировать клан',
    'err.leader_only_transfer': 'Только лидер может передать лидерство',
    'err.leader_only_disband': 'Только лидер может распустить клан',
    'err.player_not_in_clan': 'Игрок не в вашем клане',
    'err.cant_kick_leader': 'Нельзя кикнуть лидера',
    'err.officer_cant_kick_officer': 'Офицер не может кикнуть другого офицера',
    'err.insufficient_rights': 'Недостаточно прав',
    'err.boost_active': 'Буст уже активен',
    'err.need_treasury': 'Нужно {cost} алмазов в казне',
    'err.nothing_to_change': 'Нечего менять',
    'err.name_taken': 'Название уже занято',
    'err.need_coins': 'Нужно {cost} монет',
    'err.failed_create_hq': 'Не удалось создать штаб',
    'err.failed_place_hq': 'Не удалось поставить штаб. {details}',
    'err.clan_hq_not_found': 'Штаб не найден',
    'err.max_clan_level': 'Максимальный уровень',

    // ── Collectors ──
    'err.max_collectors': 'Макс {max} сборщиков (штаб Ур.{hqLevel}). Улучшите штаб.',
    'err.no_mines_nearby': 'Нет твоих шахт в радиусе {radius}м',
    'err.nothing_to_deliver': 'Нечего доставлять',
    'err.cant_attack_own_collector': 'Нельзя атаковать свой сборщик',
    'err.already_destroyed': 'Уже уничтожен',

    // ── Ore ──
    'err.ore_occupied': 'Рудник занят',
    'err.not_your_ore': 'Не ваш рудник',
    'err.ore_cant_attack': 'Нельзя атаковать',

    // ── Monuments ──
    'err.monument_defeated': 'Монумент повержен',
    'err.monument_not_shield': 'Монумент не в фазе щита',
    'err.monument_not_open': 'Монумент не открыт для атаки',
    'err.kill_defenders': 'Сначала убейте защитников!',
    'err.not_your_box': 'Не твоя коробка',
    'err.box_expired': 'Коробка просрочена',

    // ── Cores ──
    'err.core_installed': 'Ядро установлено в шахту',
    'err.all_slots_full': 'Все слоты заняты (10/10)',
    'err.core_not_installed': 'Ядро не установлено',
    'err.uninstall_core_first': 'Сначала извлеки ядро из шахты',
    'err.no_cores_available': 'Нет доступных ядер',

    // ── Vases ──
    'err.vase_too_far': 'Ваза слишком далеко! Подойди ближе ({radius}м)',

    // ── Bots ──
    'err.approach_bot': 'Подойди ближе ({distance}м > {radius}м)',

    // ── Notifications ──
    'notif.mine_attacked': '⚔️ Ваша шахта Ур.{level} атакована игроком {name}!',
    'notif.mine_burning': '🔥 Ваша шахта Ур.{level} горит! Потушите в течение 24 часов или она исчезнет.',
    'notif.mine_destroyed': '💀 Шахта Ур.{level} уничтожена огнём.',
    'notif.mine_burn_warning': '⚠️ Шахта Ур.{level} сгорит через ~6 часов!',
    'notif.pvp_defeated': '⚔️ {name} победил вас! -{coins} монет',
    'notif.pvp_defended': '🏆 Вы отразили атаку {name}! Противник потерял монеты.',
    'notif.pvp_killed': '⚔️ {name} убил вас! -{coins} монет',
    'notif.core_sold': '💰 Ваше ядро продано за {price} 💎 (получено {payout} 💎)',
    'notif.item_sold': '💰 Ваш предмет продан за {price} 💎 (получено {payout} 💎)',
    'notif.courier_killed': '💥 Ваш курьер был уничтожен! Предмет выпал на карту.',
    'notif.courier_delivered_market': '🎪 Курьер доставил товар на рынок!',
    'notif.delivery_arrived': '📦 Ваш заказ доставлен! Найдите коробку на карте.',
    'notif.coin_delivery': '📦 Посылка с {coins} монетами доставлена!',
    'notif.collector_destroyed': '💥 Твой сборщик уничтожен! Украдено {coins} монет',
    'notif.ore_captured': '⛏️ Ваш рудник Ур.{level} захвачен {name}!',
    'notif.clan_join': '⚔️ {name} вступил в клан!',
    'notif.clan_join_leader': '⚔️ {name} вступил в клан {clan}!',
    'notif.clan_donate': '💎 {name} пополнил казну на {amount} алмазов',
    'notif.clan_upgrade': '🎉 Клан достиг уровня {level}! Новые бонусы активны',
    'notif.clan_kick': '👢 Вы были исключены из клана',
    'notif.clan_disband': '💀 Клан был распущен лидером',
    'notif.clan_boost': '🚀 Клан-буст x{mul} активирован{by}! Доход увеличен на 24ч.',
    'notif.vases_spawned': '🏺 Древние вазы появились на карте! Найди и разбей их первым!',

    // ── Admin ──
    'admin.reward_coins': '🪙 монет',
    'admin.reward_diamonds': '💎 алмазов',
    'admin.reward_msg': '🎁 Вам выдано {amount} {label} от администрации игры!',
    'admin.banned': '🚫 Вы забанены. Причина: {reason}. До: {until}',
    'admin.unbanned': '✅ Вы разбанены! Добро пожаловать обратно.',
    'admin.ban_forever': 'навсегда',
    'admin.maintenance_start': '🔧 Начались технические работы. Игра временно недоступна. Следите за обновлениями!',
    'admin.maintenance_end': '✅ Технические работы завершены! Игра снова доступна. Удачной охоты! ⚔️',
    'admin.no_duplicates': 'Дублей не найдено',
    'admin.deleted_duplicates': 'Удалено {count} дублей штабов',
    'admin.purchase': '💰 Покупка!\n👤 {buyer} ({tgId})\n⭐ {stars} Stars\n💎 {diamonds} алмазов',
    'admin.diamonds_credited': '💎 {amount} алмазов зачислено!\nСпасибо за поддержку Overthrow ⚔️',

    // ── Stars ──
    'stars.title': '💎 {amount} алмазов',
    'stars.description': 'Overthrow — {amount} алмазов для игры',
    'stars.price_label': '{amount} алмазов',

    // ── Item names ──
    'item.mythic_sword': 'Адский клинок',
    'item.mythic_axe': 'Топор хаоса',
    'item.mythic_shield': 'Щит титана',

    // ── Pickup messages ──
    'pickup.received': '🎁 Получено!',
    'pickup.coins': '💰 +{coins} монет!',
    'pickup.item_picked': 'Предмет подобран!',
    'pickup.intercepted': 'Курьер перехвачен! Предмет украден, покупателю возврат.',

    // ── Kill messages ──
    'kill.defenders': '⚠️ Убейте защитников!',
  },

  en: {
    // ── Common errors ──
    'err.missing_fields': 'Missing required fields',
    'err.player_not_found': 'Player not found',
    'err.conflict': 'Conflict — please try again',
    'err.db_unavailable': 'Server temporarily unavailable, try again in a minute',
    'err.forbidden': 'Access denied',
    'err.unknown_action': 'Unknown action',

    // ── Distance / position ──
    'err.too_far': 'Too far ({distance}m > {radius}m)',
    'err.too_far_short': 'Too far',
    'err.too_far_closer': 'Too far! Get closer ({radius}m)',
    'err.invalid_coords': 'Invalid coordinates',
    'err.coords_required': 'Player coordinates not provided',
    'err.gps_not_ready': 'GPS not ready',
    'err.approach': 'Get closer ({distance}m > {radius}m)',

    // ── Player ──
    'err.cant_attack_self': 'Cannot attack yourself',
    'err.player_shielded': 'Player is shielded',
    'err.username_length': 'Username must be 3-16 characters',
    'err.username_chars': 'Only letters, digits and _',
    'err.username_taken': 'This username is already taken',
    'err.not_enough_diamonds': 'Not enough diamonds (need {cost} 💎)',
    'err.not_enough_diamonds_short': 'Not enough diamonds',
    'err.not_enough_coins': 'Not enough coins (need {cost})',
    'err.not_enough_ether': 'Not enough ether',
    'err.not_enough_crystals': 'Need {cost} ✨',
    'err.respawn_wait': 'Respawning in {seconds} sec',
    'err.already_claimed': 'Already claimed',
    'err.dead': 'You are dead!',

    // ── HQ ──
    'err.hq_exists': 'Headquarters already placed',
    'err.no_free_cells': 'No free cells nearby',
    'err.bonus_claimed': 'Bonus already claimed',
    'err.hq_not_found': 'Headquarters not found',
    'err.hq_max_level': 'Headquarters already at max level',
    'err.need_hq_first': 'You must place your headquarters first',

    // ── Mine ──
    'err.cell_occupied': 'Cell already occupied',
    'err.cant_attack_own_mine': 'Cannot attack your own mine',
    'err.mine_already_attacked': 'Mine is already under attack',
    'err.mine_inactive': 'Mine is inactive',
    'err.mine_not_attacked': 'Mine is not under attack',
    'err.not_attacking_mine': 'You are not attacking this mine',
    'err.attack_not_finished': 'Attack not finished yet',
    'err.already_attacking': 'You are already attacking another mine',
    'err.mine_not_yours': 'Not your mine',
    'err.mine_not_burning': 'Mine is not burning',
    'err.mine_burned': 'Mine burned down — too late',
    'err.mine_unavailable': 'Mine unavailable for attack',
    'err.upgrade_in_progress': 'Upgrade in progress ({seconds} sec)',
    'err.target_level_higher': 'Target level must be higher than current',

    // ── Items ──
    'err.item_not_found': 'Item not found',
    'err.unequip_first': 'Unequip item first',
    'err.item_on_market': 'Item is on market',
    'err.max_level': 'Maximum level reached',
    'err.need_10_items': 'Exactly 10 items required',
    'err.items_not_found': 'Some items not found or not yours',
    'err.same_rarity': 'All items must be the same rarity',
    'err.unequip_crafting': 'Unequip items before crafting',
    'err.legendary_no_craft': 'Legendary items cannot be crafted',
    'err.no_items_to_sell': 'No items to sell',
    'err.max_200_items': 'Maximum 200 items at once',
    'err.need_diamonds': 'Need {cost} 💎',

    // ── Market ──
    'err.listing_not_found': 'Listing not found or expired',
    'err.not_your_parcel': 'This is not your parcel',

    // ── Clan ──
    'err.clan_hq_exists': 'You already have a clan HQ',
    'err.already_in_clan': 'You are already in a clan',
    'err.not_in_clan': 'You are not in a clan',
    'err.build_clan_hq_first': 'Build a clan HQ first',
    'err.clan_name_taken': 'Clan name already taken',
    'err.clan_name_length': 'Name: 3-20 characters',
    'err.clan_symbol_length': 'Symbol: one emoji',
    'err.clan_color_invalid': 'Invalid color',
    'err.clan_not_found': 'Clan not found',
    'err.clan_min_level': 'Min level: {level}',
    'err.clan_full': 'Clan is full',
    'err.leader_cant_leave': 'Leader cannot leave. Transfer leadership first.',
    'err.invalid_amount': 'Invalid amount',
    'err.leader_or_officer': 'Leader or officer only',
    'err.leader_only': 'Only leader can change roles',
    'err.leader_only_edit': 'Only leader can edit clan',
    'err.leader_only_transfer': 'Only leader can transfer leadership',
    'err.leader_only_disband': 'Only leader can disband clan',
    'err.player_not_in_clan': 'Player is not in your clan',
    'err.cant_kick_leader': 'Cannot kick the leader',
    'err.officer_cant_kick_officer': 'Officer cannot kick another officer',
    'err.insufficient_rights': 'Insufficient rights',
    'err.boost_active': 'Boost already active',
    'err.need_treasury': 'Need {cost} diamonds in treasury',
    'err.nothing_to_change': 'Nothing to change',
    'err.name_taken': 'Name already taken',
    'err.need_coins': 'Need {cost} coins',
    'err.failed_create_hq': 'Failed to create HQ',
    'err.failed_place_hq': 'Failed to place HQ. {details}',
    'err.clan_hq_not_found': 'HQ not found',
    'err.max_clan_level': 'Maximum level reached',

    // ── Collectors ──
    'err.max_collectors': 'Max {max} collectors (HQ Lv.{hqLevel}). Upgrade HQ.',
    'err.no_mines_nearby': 'No mines of yours within {radius}m',
    'err.nothing_to_deliver': 'Nothing to deliver',
    'err.cant_attack_own_collector': 'Cannot attack your own collector',
    'err.already_destroyed': 'Already destroyed',

    // ── Ore ──
    'err.ore_occupied': 'Ore node occupied',
    'err.not_your_ore': 'Not your ore node',
    'err.ore_cant_attack': 'Cannot attack',

    // ── Monuments ──
    'err.monument_defeated': 'Monument is defeated',
    'err.monument_not_shield': 'Monument not in shield phase',
    'err.monument_not_open': 'Monument not open for attack',
    'err.kill_defenders': 'Kill defenders first!',
    'err.not_your_box': 'Not your box',
    'err.box_expired': 'Box expired',

    // ── Cores ──
    'err.core_installed': 'Core is installed in a mine',
    'err.all_slots_full': 'All slots occupied (10/10)',
    'err.core_not_installed': 'Core is not installed',
    'err.uninstall_core_first': 'Uninstall core from mine first',
    'err.no_cores_available': 'No cores available',

    // ── Vases ──
    'err.vase_too_far': 'Vase too far! Get closer ({radius}m)',

    // ── Bots ──
    'err.approach_bot': 'Get closer ({distance}m > {radius}m)',

    // ── Notifications ──
    'notif.mine_attacked': '⚔️ Your mine Lv.{level} attacked by {name}!',
    'notif.mine_burning': '🔥 Your mine Lv.{level} is burning! Extinguish within 24 hours or it will be destroyed.',
    'notif.mine_destroyed': '💀 Mine Lv.{level} destroyed by fire.',
    'notif.mine_burn_warning': '⚠️ Mine Lv.{level} will burn down in ~6 hours!',
    'notif.pvp_defeated': '⚔️ {name} defeated you! -{coins} coins',
    'notif.pvp_defended': '🏆 You repelled {name}\'s attack! Opponent lost coins.',
    'notif.pvp_killed': '⚔️ {name} killed you! -{coins} coins',
    'notif.core_sold': '💰 Your core sold for {price} 💎 (received {payout} 💎)',
    'notif.item_sold': '💰 Your item sold for {price} 💎 (received {payout} 💎)',
    'notif.courier_killed': '💥 Your courier was destroyed! Item dropped on map.',
    'notif.courier_delivered_market': '🎪 Courier delivered goods to market!',
    'notif.delivery_arrived': '📦 Your order delivered! Find the box on the map.',
    'notif.coin_delivery': '📦 Package with {coins} coins delivered!',
    'notif.collector_destroyed': '💥 Your collector destroyed! {coins} coins stolen',
    'notif.ore_captured': '⛏️ Your ore node Lv.{level} captured by {name}!',
    'notif.clan_join': '⚔️ {name} joined the clan!',
    'notif.clan_join_leader': '⚔️ {name} joined clan {clan}!',
    'notif.clan_donate': '💎 {name} donated {amount} diamonds to treasury',
    'notif.clan_upgrade': '🎉 Clan reached level {level}! New bonuses active',
    'notif.clan_kick': '👢 You were kicked from the clan',
    'notif.clan_disband': '💀 Clan was disbanded by the leader',
    'notif.clan_boost': '🚀 Clan boost x{mul} activated{by}! Income increased for 24h.',
    'notif.vases_spawned': '🏺 Ancient vases appeared on the map! Find and break them first!',

    // ── Admin ──
    'admin.reward_coins': '🪙 coins',
    'admin.reward_diamonds': '💎 diamonds',
    'admin.reward_msg': '🎁 You received {amount} {label} from game administration!',
    'admin.banned': '🚫 You are banned. Reason: {reason}. Until: {until}',
    'admin.unbanned': '✅ You are unbanned! Welcome back.',
    'admin.ban_forever': 'forever',
    'admin.maintenance_start': '🔧 Maintenance in progress. Game temporarily unavailable. Stay tuned!',
    'admin.maintenance_end': '✅ Maintenance complete! Game is back online. Happy hunting! ⚔️',
    'admin.no_duplicates': 'No duplicates found',
    'admin.deleted_duplicates': 'Deleted {count} duplicate HQs',
    'admin.purchase': '💰 Purchase!\n👤 {buyer} ({tgId})\n⭐ {stars} Stars\n💎 {diamonds} diamonds',
    'admin.diamonds_credited': '💎 {amount} diamonds credited!\nThank you for supporting Overthrow ⚔️',

    // ── Stars ──
    'stars.title': '💎 {amount} diamonds',
    'stars.description': 'Overthrow — {amount} diamonds for the game',
    'stars.price_label': '{amount} diamonds',

    // ── Item names ──
    'item.mythic_sword': 'Infernal Blade',
    'item.mythic_axe': 'Chaos Axe',
    'item.mythic_shield': 'Titan Shield',

    // ── Pickup messages ──
    'pickup.received': '🎁 Received!',
    'pickup.coins': '💰 +{coins} coins!',
    'pickup.item_picked': 'Item picked up!',
    'pickup.intercepted': 'Courier intercepted! Item stolen, buyer refunded.',

    // ── Kill messages ──
    'kill.defenders': '⚠️ Kill the defenders!',
  },
};

/**
 * Get translated string for server-side messages
 * @param {string} lang - 'ru' or 'en'
 * @param {string} key - translation key
 * @param {object} [params] - interpolation parameters
 * @returns {string}
 */
export function ts(lang, key, params) {
  let s = TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS['en']?.[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}

/**
 * Get player language from gameState
 * @param {object} gameState
 * @param {number|string} tgId - telegram_id
 * @returns {string} 'ru' or 'en'
 */
export function getLang(gameState, tgId) {
  return gameState.getPlayerByTgId(tgId)?.language || 'en';
}
