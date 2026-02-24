// =================================================================================
// =                         ГЛАВНЫЙ ОБРАБОТЧИК (WEBHOOK)                          =
// =================================================================================

/**
 * Главный обработчик, в который добавлена обработка нажатий на inline-кнопки.
 * Является точкой входа для всех запросов от Telegram.
 */
function doPost(e) {
  try {
    // sendDebugMessage('🚀 `doPost` запущен. Обрабатываю входящий запрос.');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);

    try {
      const payload = JSON.parse(e.postData.contents);
      // sendDebugMessage('📄 Полезная нагрузка JSON успешно разобрана.');

      if (payload.callback_query) {
        // sendDebugMessage('🖱️ Обнаружен callback_query (нажатие кнопки).');
        handleCallbackQuery(payload.callback_query);
      } else if (payload.source === 'rfid_reader' && payload.eventType === 'scan') {
        // sendDebugMessage('💳 Обнаружено сканирование RFID.');
        handleRfidScan(payload.payload.uid);
      } else if (payload.message) {
        // sendDebugMessage('✉️ Обнаружено входящее сообщение.');
        handleTelegramMessage(payload.message);
      } else {
        // sendDebugMessage('❓ Неизвестный тип запроса в `doPost`.');
      }

    } catch (err) {
      Logger.log('Критическая ошибка в doPost: ' + err.toString() + ' | Request body: ' + e.postData.contents);
      sendDebugMessage('🔥 КРИТИЧЕСКАЯ ОШИБКА в `doPost`:\n' + err.toString());
      if (err.toString().includes('Lock timed out')) {
        try {
          const payload = JSON.parse(e.postData.contents);
          if (payload.message && payload.message.chat && payload.message.chat.id) {
            const chatId = payload.message.chat.id;
            const threadId = payload.message.message_thread_id || 0;
            const messageId = payload.message.message_id;
            const errorMessage = "⏳ Сервер зараз зайнятий обробкою іншого запиту. Будь ласка, повторіть спробу за хвилину.";
            sendPostToTelegram(chatId, errorMessage, threadId, messageId);
          }
        } catch (parseErr) {
          Logger.log('Не удалось отправить сообщение о тайм-ауте, ошибка парсинга: ' + parseErr.toString());
        }
      }
    } finally {
      lock.releaseLock();
      // sendDebugMessage('✅ `doPost` завершен.');
    }
  } catch(e) {
      sendDebugMessage(`ВНЕШНЯЯ ОШИБКА в doPost: ${e.toString()}`);
  }
}
