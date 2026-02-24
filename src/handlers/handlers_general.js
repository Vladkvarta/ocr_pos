// =================================================================================
// =                          ОБЩИЕ ОБРАБОТЧИКИ СООБЩЕНИЙ                         =
// =================================================================================

/**
 * Отправляет отладочное сообщение в заданный чат.
 * @param {string} text - Текст сообщения для отладки.
 */
function sendDebugMessage(text) {
  try {
    if (!DEBUG_CHAT_ID || DEBUG_CHAT_ID === 'YOUR_TELEGRAM_ID_HERE') {
      return;
    }
    const maxLength = 4096;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength - 3) + "..." : text;
    
    sendPostToTelegram(DEBUG_CHAT_ID, truncatedText);
  } catch (e) {
    Logger.log("НЕ УДАЛОСЬ ОТПРАВИТЬ ОТЛАДОЧНОЕ СООБЩЕНИЕ: " + e.toString());
  }
}

/**
 * Обработка разных типов файлов: фото с промптом, документы, аудио.
 */
function handleFileAnalysis(message) {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id || 0;
  const messageId = message.message_id;
  const fromName = message.from.first_name || 'Користувач';
  const prompt = message.caption;
  let fileId;
  let mimeType;
  if (message.photo) {
    fileId = message.photo[message.photo.length - 1].file_id;
    mimeType = 'image/jpeg';
  } else if (message.document) {
    fileId = message.document.file_id;
    mimeType = message.document.mime_type;
  } else if (message.audio) {
    fileId = message.audio.file_id;
    mimeType = message.audio.mime_type;
  }
  if (!prompt || !fileId) { return; }
  try {
    sendPostToTelegram(chatId, "Отримав ваш файл, починаю аналіз...", threadId, messageId);
    const fileBlob = getFileBlobFromTelegram(fileId);
    const base64Data = Utilities.base64Encode(fileBlob.getBytes());
    
    // Логика вызова Gemini API теперь находится прямо здесь, без лишней функции-обертки
    const systemInstruction = `Ты — Smakuie_Bot, дружелюбный и остроумный ИИ-помощник в Telegram. Твоя главная задача - быть полезным и вести осмысленную беседу. Обращайся к пользователю по имени: ${fromName || 'друже'}. Ответ всегда давай только на украинском языке.`;
    const finalPrompt = `${systemInstruction}\n\nЗавдання:\n${prompt}`;
    const payload = {
      "contents": [{
        "parts": [
          { "text": finalPrompt },
          { "inline_data": { "mime_type": mimeType, "data": base64Data } }
        ]
      }]
    };
    const geminiResponse = callGeminiAPI(payload);

    if (geminiResponse) {
      sendPostToTelegram(chatId, geminiResponse, threadId, messageId);
    } else {
      sendPostToTelegram(chatId, "На жаль, не вдалося проаналізувати файл.", threadId, messageId);
    }
  } catch (e) {
    Logger.log("Ошибка при анализе файла: " + e.toString());
    sendPostToTelegram(chatId, "Під час аналізу файлу сталася помилка.", threadId, messageId);
  }
}

/**
 * Обработка голосовых сообщений.
 */
function handleVoiceMessage(message) {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id || 0;
  const messageId = message.message_id;
  try {
    sendPostToTelegram(chatId, "Отримав голосове, розшифровую...", threadId, messageId);
    const fileId = message.voice.file_id;
    const mimeType = message.voice.mime_type;
    const fileBlob = getFileBlobFromTelegram(fileId);
    const base64Data = Utilities.base64Encode(fileBlob.getBytes());
    const transcriptionPrompt = "Розшифруй це голосове повідомлення в текст. Поверни тільки сам текст без додаткових коментарів.";
    
    // Логика вызова Gemini API для транскрипции
    const payload = {
      "contents": [{
        "parts": [
          { "text": transcriptionPrompt },
          { "inline_data": { "mime_type": mimeType, "data": base64Data } }
        ]
      }]
    };
    const transcribedText = callGeminiAPI(payload);

    if (transcribedText) {
      sendPostToTelegram(chatId, `Розшифрований текст: "_${transcribedText}_"\n\nТепер обробляю запит...`, threadId, messageId);
      const textMessage = { ...message };
      textMessage.text = transcribedText;
      handleContinuousConversation(textMessage);
    } else {
      sendPostToTelegram(chatId, "Не вдалося розшифрувати голосове повідомлення.", threadId, messageId);
    }
  } catch (e) {
    Logger.log("Ошибка при обработке голосового сообщения: " + e.toString());
    sendPostToTelegram(chatId, "Під час обробки голосового сталася помилка.", threadId, messageId);
  }
}

/**
 * Обработка обычных текстовых сообщений (включая упоминания и ответы боту).
 */
function handleContinuousConversation(message) {
  const cache = CacheService.getScriptCache();
  const chatId = message.chat.id;
  const fromId = message.from.id;
  const fromName = message.from.first_name || 'Користувач';
  const threadId = message.message_thread_id || 0;
  const messageId = message.message_id;
  const text = message.text;
  const chatType = message.chat.type;
  const cacheKey = `conversation_${chatId}_${threadId}_${fromId}`;
  const isPrivateChat = chatType === 'private';
  const isReplyToBot = message.reply_to_message && message.reply_to_message.from.username === BOT_USERNAME;
  const isMentioned = text.includes(`@${BOT_USERNAME}`);
  if (!isPrivateChat && !isReplyToBot && !isMentioned) { return; }
  if (isMentioned && !isReplyToBot) { cache.remove(cacheKey); }
  let conversation = JSON.parse(cache.get(cacheKey) || 'null');
  if (!conversation) {
    conversation = { history: [] };
    if (isPrivateChat || isMentioned) {
      sendPostToTelegram(chatId, `Для користувача *${fromName}* відкрита нова сесія, яка автоматично закриється через 6 годин бездіяльності.`, threadId);
    }
  }
  conversation.history.push({
    role: 'user',
    parts: [{ text: text }]
  });
  
  // Логика вызова Gemini API для диалога
  const systemInstruction = {
    role: 'user',
    parts: [{ text: `Ты — Smakuie_Bot, дружелюбный и остроумный ИИ-помощник в Telegram. Твоя главная задача - быть полезным и вести осмысленную беседу. Обращайся к пользователю по имени: ${fromName}. Будь кратким и вежливым. Не задавай лишних вопросов, если можешь ответить сразу. Ответ всегда давай только на украинском языке` }]
  };
  const payload = { "contents": [systemInstruction, ...conversation.history] };
  const geminiResponse = callGeminiAPI(payload) || "Вибачте, сталася помилка. Спробуйте пізніше.";

  if (geminiResponse) {
    const sentMessage = sendPostToTelegram(chatId, geminiResponse, threadId, messageId);
    if (sentMessage) {
      conversation.history.push({
        role: 'model',
        parts: [{ text: geminiResponse }]
      });
    }
  }
  cache.put(cacheKey, JSON.stringify(conversation), 21600);
}
