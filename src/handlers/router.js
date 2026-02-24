// =================================================================================
// =                ОСНОВНЫЕ ОБРАБОТЧИК И (ЛОГИКА)                                =
// =================================================================================

/**
 * Главный маршрутизатор сообщений Telegram с новой логикой обработки фото.
 * @param {object} message - Объект сообщения от Telegram.
 */
function handleTelegramMessage(message) {
  const cache = CacheService.getScriptCache();
  const caption = message.caption ? message.caption.trim().toLowerCase() : '';

  if (message.reply_to_message && message.reply_to_message.from.username === BOT_USERNAME) {
    const stateKey = `invoice_processing_${message.chat.id}_${message.reply_to_message.message_id}`;
    const stateJSON = cache.get(stateKey);
    if (stateJSON) {
      handleUserCorrection(message, stateKey, JSON.parse(stateJSON));
      return;
    }
  }

  checkAndRegisterLocation(message.chat.id, message.chat.title, message.message_thread_id || 0, message.chat.type, message.from.first_name);

  if (message.photo) {
    if (caption === 'накладна') { // ИЗМЕНЕН ТРИГГЕР
      startInvoiceProcessing(message);
      return;
    }
    else if (caption.startsWith('2 ')) {
      const messageForAnalysis = { ...message };
      messageForAnalysis.caption = caption.substring(2);
      handleFileAnalysis(messageForAnalysis);
      return;
    }
  } else if (message.voice) {
    handleVoiceMessage(message);
  } else if ((message.document || message.audio) && caption) {
    handleFileAnalysis(message);
  } else if (message.text) {
    if (message.text.startsWith('/')) {
      handleCommand(message);
    } else {
      handleContinuousConversation(message);
    }
  }
}

/**
 * Обработка нажатий на inline-кнопки
 */
function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const originalMessageText = callbackQuery.message.text;
  const fromId = callbackQuery.from.id;

  sendDebugMessage(`Нажата кнопка. User: ${fromId}, Data: ${data}`);

  if (data.startsWith('edit_errors_')) {
    const stateKey = data.replace('edit_errors_', '');
    askForCorrectionDetails(chatId, stateKey);
    editMessageText(chatId, messageId, originalMessageText + "\n\n*(Режим виправлення)*");

  } else if (data.startsWith('confirm_review_')) {
    const stateKey = data.replace('confirm_review_', '');
    const stateJSON = CacheService.getScriptCache().get(stateKey);
    if (stateJSON) {
      const state = JSON.parse(stateJSON);
      editMessageText(chatId, messageId, originalMessageText + "\n\n*(✅ Перевірено)*");
      presentTradePointSelection(state, chatId, stateKey, fromId);
    } else {
      sendPostToTelegram(chatId, "❌ Помилка: сесія для цієї накладної застаріла. Спробуйте знову.");
    }

  } else if (data.startsWith('select_tradepoint_')) {
    const parts = data.split('_');
    const tradePointKey = parts[2]; // Теперь это текстовый ключ
    // ИСПРАВЛЕНИЕ: ID чата уже содержится в данных с кнопки.
    // Не нужно добавлять его еще раз, чтобы ключ состояния был правильным.
    const stateKeyIdentifier = parts.slice(3).join('_');
    const stateKey = `invoice_processing_${stateKeyIdentifier}`;
    const stateJSON = CacheService.getScriptCache().get(stateKey);
    if (stateJSON) {
      const state = JSON.parse(stateJSON);
      state.selectedTradePointKey = tradePointKey; // Сохраняем выбранный ключ в состояние
      CacheService.getScriptCache().put(stateKey, JSON.stringify(state), 21600);
      editMessageText(chatId, messageId, originalMessageText + `\n\n*(✅ Обрано: ${TRADE_POINTS_CONFIG[tradePointKey].name})*`);
      presentFinalConfirmation(state, chatId, stateKey);
    } else {
      sendPostToTelegram(chatId, "❌ Помилка: сесія для цієї накладної застаріла. Спробуйте знову.");
    }

  } else if (data.startsWith('send_to_skyservice_')) {
    const stateKey = data.replace('send_to_skyservice_', '');
    const stateJSON = CacheService.getScriptCache().get(stateKey);
    if (stateJSON) {
      const state = JSON.parse(stateJSON);
      editMessageText(chatId, messageId, originalMessageText + "\n\n*(Обробка...)*");
      sendToSkyService(state, chatId, messageId, originalMessageText);
      CacheService.getScriptCache().remove(stateKey);
    } else {
      sendPostToTelegram(chatId, "❌ Помилка: сесія для цієї накладної застаріла. Спробуйте знову.");
    }
  }
}


/**
 * Обработка текстовых команд.
 */
function handleCommand(message) {
  const text = message.text;
  const chatId = message.chat.id;
  const fromId = message.from.id;
  const threadId = message.message_thread_id || 0;
  const cacheKey = `conversation_${chatId}_${threadId}_${fromId}`;

  if (text.startsWith('/myid')) {
    let userResponse;
    if (message.chat.type === 'private') {
      userResponse = `Це приватний чат (ЛС)\nID чату - ${chatId}`;
    } else {
      const threadIdForDisplay = threadId === 0 ? 'не в темі' : threadId;
      userResponse = `Назва групи - ${message.chat.title}\nID групи - ${chatId}\nID Теми - ${threadIdForDisplay}`;
    }
    sendPostToTelegram(chatId, userResponse, threadId);

  } else if (text.startsWith('/clearHistory')) {
    const cache = CacheService.getScriptCache();
    cache.remove(cacheKey);
    sendPostToTelegram(chatId, '🗑️ Історія цієї сесії була очищена.', threadId, message.message_id);

  } else if (text.startsWith('/getHistory')) {
    const cache = CacheService.getScriptCache();
    const conversationJSON = cache.get(cacheKey);

    if (conversationJSON) {
      const conversation = JSON.parse(conversationJSON);
      let formattedHistory = `Історія діалогу з ${message.from.first_name || 'Користувач'} в чаті ${chatId}\n========================================\n\n`;

      conversation.history.forEach(item => {
        const role = item.role === 'user' ? 'Користувач' : 'Бот';
        const messageText = item.parts[0].text;
        formattedHistory += `${role}:\n${messageText}\n\n----------------------------------------\n\n`;
      });

      const historyBlob = Utilities.newBlob(formattedHistory, 'text/plain', `history_${chatId}_${fromId}.txt`);
      sendDocumentToTelegram(chatId, historyBlob, "Ваша історія діалогу:", threadId);

    } else {
      sendPostToTelegram(chatId, '🤷‍♂️ Історія для цієї сесії порожня.', threadId, message.message_id);
    }
  }
}
