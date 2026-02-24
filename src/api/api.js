// =================================================================================
// =                          API: TELEGRAM & GEMINI                             =
// =================================================================================

/**
 * Отправляет текстовое сообщение в Telegram.
 */
function sendPostToTelegram(chatId, text, threadId, replyToMessageId, inlineKeyboard) {
  if (!TELEGRAM_BOT_TOKEN) {
    Logger.log('Токен Telegram не найден в PropertiesService.');
    return null;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    'chat_id': String(chatId),
    'text': text,
    'parse_mode': 'Markdown'
  };
  if (threadId && threadId != '0' && threadId != 'ЛС') {
    payload.message_thread_id = threadId;
  }
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }
  if (inlineKeyboard) {
    payload.reply_markup = JSON.stringify(inlineKeyboard);
  }
  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'payload': JSON.stringify(payload),
    'muteHttpExceptions': true
  };
  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    if (responseCode === 200) {
      return JSON.parse(responseText);
    } else {
      if (chatId != DEBUG_CHAT_ID) {
         sendDebugMessage(`ОШИБКА ОТПРАВКИ в Telegram: ${responseCode} - ${responseText}`);
      }
      Logger.log(`Ошибка отправки в Telegram: ${responseCode} - ${responseText}`);
      return null;
    }
  } catch (e) {
    Logger.log('Исключение при отправке в Telegram: ' + e.toString());
    return null;
  }
}

/**
 * Отправляет документ в Telegram.
 */
function sendDocumentToTelegram(chatId, blob, caption, threadId) {
  if (!TELEGRAM_BOT_TOKEN) {
    Logger.log('Токен Telegram не найден в PropertiesService.');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
  const payload = {
    chat_id: String(chatId),
    document: blob,
    caption: caption
  };
  if (threadId && threadId != '0' && threadId != 'ЛС') {
    payload.message_thread_id = threadId;
  }
  const options = {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  };
  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    if (responseCode === 200) {
      return JSON.parse(responseText);
    } else {
      Logger.log(`Ошибка отправки документа в Telegram: ${responseCode} - ${responseText}`);
      return null;
    }
  } catch (e) {
    Logger.log('Исключение при отправке документа в Telegram: ' + e.toString());
    return null;
  }
}

/**
 * Редактирует текст существующего сообщения.
 */
function editMessageText(chatId, messageId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const payload = {
    chat_id: String(chatId),
    message_id: messageId,
    text: text,
    parse_mode: 'Markdown'
  };
  UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
}

/**
 * Скачивает файл из Telegram по его ID.
 */
function getFileBlobFromTelegram(fileId) {
  const fileResponse = UrlFetchApp.fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const filePath = JSON.parse(fileResponse.getContentText()).result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  return UrlFetchApp.fetch(fileUrl).getBlob();
}

/**
 * Базовая функция для вызова Gemini API.
 */
function callGeminiAPI(payload) {
  if (!GEMINI_API_KEY) {
    sendDebugMessage("🔥 ОШИБКА: Ключ API Gemini не найден.");
    Logger.log('Ключ API Gemini не найден в PropertiesService.');
    return "Вибачте, сталася помилка конфігурації сервера.";
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
  const options = { 'method': 'post', 'contentType': 'application/json', 'payload': JSON.stringify(payload), 'muteHttpExceptions': true };
  try {
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());
    if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts[0].text) {
      return data.candidates[0].content.parts[0].text;
    } else {
      sendDebugMessage(`🔥 ОШИБКА: Gemini не вернул корректный ответ. Response: ${JSON.stringify(data)}`);
      Logger.log("Gemini не вернул корректный ответ. Response: " + JSON.stringify(data));
      return null;
    }
  } catch (e) {
    sendDebugMessage(`🔥 ОШИБКА API Gemini: ${e.toString()}`);
    Logger.log(`Ошибка API Gemini: ${e.toString()}`);
  }
  return null;
}