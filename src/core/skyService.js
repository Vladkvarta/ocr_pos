// =================================================================================
// =                НОВЫЙ ФУНКЦИОНАЛ: ОТПРАВКА В SKYSERVICE                   =
// =================================================================================

/**
 * Генерирует уникальный идентификатор (UUID v4).
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Отправляет данные накладной в SkyService в четыре этапа с верификацией.
 * @param {object} state - Объект состояния с данными накладной.
 * @param {string|number} chatId - ID чата для отправки ответа.
 * @param {string|number} messageId - ID сообщения для редактирования.
 * @param {string} originalMessageText - Исходный текст сообщения.
 */
function sendToSkyService(state, chatId, messageId, originalMessageText) {
  sendDebugMessage("--- НАЧАЛО ОТПРАВКИ В SKYSERVICE (4-х этапная, динамическая версия) ---");
  
  const formId = generateUUID();
  const tradePointKey = state.selectedTradePointKey; // Теперь это уникальный текстовый ключ

  if (!tradePointKey || !TRADE_POINTS_CONFIG[tradePointKey]) {
    sendDebugMessage(`🔥 КРИТИЧЕСКАЯ ОШИБКА: Ключ торговой точки (${tradePointKey}) не был выбран или не настроен.`);
    sendPostToTelegram(chatId, "❌ Помилка: не обрано або не налаштовано торгову точку. Спробуйте знову.");
    return;
  }

  // Получаем все необходимые ID из конфига
  const config = TRADE_POINTS_CONFIG[tradePointKey];
  const companyId = config.companyId;
  const tradePointId = config.tradePointId;
  const warehouseId = config.warehouseId;

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0];
  
  // --- ЭТАП 1: Создание черновика (createDraft) ---
  let draftId;
  try {
    sendDebugMessage(`SkyService - Этап 1: Создание черновика (action=createDraft) с timezone=${SKY_TIMEZONE}...`);
    const createUrl = `${SKY_API_URL}?action=createDraft&section=drafts&timezone=${SKY_TIMEZONE}&token=${SKY_TOKEN}&device_uuid=${SKY_DEVICE_UUID}&companyId=${companyId}&tradepointId=${tradePointId}`;
    
    const createPayload = {
      "formId": formId, "tradepointId": tradePointId, "date": dateStr, "time": timeStr, "backdatingCheckbox": false, "attachmentFiles": [], "provider": {"providerId":null,"providerName":""}, "expenses": -16, "payment": {"status":null,"from":null}, "products": [{"barcode":"","quantity":"","cost":"","summ":"","price":"","nomenclatureId":""}], "comment": "", "warehouseId": "", "changeChannelPrice": false, "channelId": null, "sumCost": 0, "draftType": "coming", "workerId": state.workerId || 1
    };

    const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(createPayload), muteHttpExceptions: true };
    
    const response = UrlFetchApp.fetch(createUrl, options);
    const responseText = response.getContentText();
    sendDebugMessage(`SkyService - Этап 1: Ответ от сервера:\n\`\`\`\n${responseText}\n\`\`\``);
    const responseData = JSON.parse(responseText);

    if (responseData.status === 'done' && responseData.data) {
      draftId = responseData.data;
      sendDebugMessage(`SkyService - Этап 1 УСПЕШНО. Получен draftId: ${draftId}`);
    } else {
      throw new Error(`Не удалось создать черновик. Ответ: ${responseText}`);
    }
  } catch (e) {
    sendDebugMessage(`🔥 ОШИБКА на Этапе 1 (createDraft): ${e.toString()}`);
    sendPostToTelegram(chatId, "❌ Помилка при створенні чернетки в SkyService.");
    editMessageText(chatId, messageId, originalMessageText + "\n\n*(Помилка створення чернетки)*");
    return;
  }

  // --- ЭТАП 2: Первичное сохранение пустого черновика (saveDraft) ---
  try {
    sendDebugMessage(`SkyService - Этап 2: Первичное сохранение для закрепления (action=saveDraft) с draftId: ${draftId} и timezone=${SKY_TIMEZONE}`);
    const saveUrl = `${SKY_API_URL}?action=saveDraft&section=drafts&timezone=${SKY_TIMEZONE}&token=${SKY_TOKEN}&device_uuid=${SKY_DEVICE_UUID}&companyId=${companyId}&tradepointId=${tradePointId}&draftId=${draftId}`;
    
    const emptySavePayload = {
      "formId": formId, "tradepointId": tradePointId, "date": dateStr, "time": timeStr, "backdatingCheckbox": false, "attachmentFiles": [], "provider": {"providerId":null,"providerName":""}, "expenses": -16, "payment": {"status":null,"from":null}, "products": [{"barcode":"","quantity":"","cost":"","summ":"","price":"","nomenclatureId":""}], "comment": "", "warehouseId": warehouseId, "changeChannelPrice": false, "channelId": null, "sumCost": 0, "draftType": "coming"
    };

    const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(emptySavePayload), muteHttpExceptions: true };

    const response = UrlFetchApp.fetch(saveUrl, options);
    const responseText = response.getContentText();
    sendDebugMessage(`SkyService - Этап 2: Ответ от сервера:\n\`\`\`\n${responseText}\n\`\`\``);
    const responseData = JSON.parse(responseText);

    if (responseData.status !== 'done') {
      throw new Error(`Не удалось выполнить первичное сохранение. Ответ: ${responseText}`);
    }
    sendDebugMessage(`SkyService - Этап 2 УСПЕШНО. Черновик закреплен.`);

  } catch (e) {
    sendDebugMessage(`🔥 ОШИБКА на Этапе 2 (пустой saveDraft): ${e.toString()}`);
    sendPostToTelegram(chatId, "❌ Помилка при закріпленні чернетки в SkyService.");
    editMessageText(chatId, messageId, originalMessageText + "\n\n*(Помилка закріплення чернетки)*");
    return;
  }

  // --- Подготовка основного Payload для этапов 3 и 4 ---
  const fullNomenclature = getProductNomenclature(); 

  const productsPayload = state.items.map(item => {
    const cost = parseFloat((item.final_price || 0).toFixed(2));
    const quantity = item.quantity || 0;
    const summ = parseFloat((item.sum || (cost * quantity)).toFixed(2));
    
    let nomenclatureNameFromDb = item.name; 
    if (item.product_id && fullNomenclature) {
        const matchedProduct = fullNomenclature.find(p => p.product_id == item.product_id);
        if (matchedProduct) {
            nomenclatureNameFromDb = matchedProduct.name;
        }
    }

    return { 
        "barcode":"", "quantity": quantity, "cost": cost, "summ": summ, "price":0, "nomenclatureId": item.product_id, "savedCost": cost, "nomenclatureName": nomenclatureNameFromDb, "unit": item.unit, "markup":"0", "actualPrice":0, "deleted":false, "summPrice":0
    };
  });
  const totalSum = productsPayload.reduce((acc, item) => acc + item.summ, 0);
  const finalPayload = {
    "formId": formId, "tradepointId": tradePointId, "date": dateStr, "time": timeStr, "backdatingCheckbox": false, "attachmentFiles": [], "provider": { "providerId": null, "providerName": state.supplier }, "expenses": -16, "payment": { "status": "credit", "from": -1 }, "products": productsPayload, "comment": "", "warehouseId": warehouseId, "changeChannelPrice": false, "channelId": null, "sumCost": parseFloat(totalSum.toFixed(2))
  };

  // --- ЭТАП 3: Сохранение с данными (saveDraft) ---
  try {
    sendDebugMessage(`SkyService - Этап 3: Сохранение данных в черновик (action=saveDraft) с draftId: ${draftId} и timezone=${SKY_TIMEZONE}`);
    const finalSaveUrl = `${SKY_API_URL}?action=saveDraft&section=drafts&timezone=${SKY_TIMEZONE}&token=${SKY_TOKEN}&device_uuid=${SKY_DEVICE_UUID}&companyId=${companyId}&tradepointId=${tradePointId}&draftId=${draftId}`;

    const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(finalPayload), muteHttpExceptions: true };
    
    const response = UrlFetchApp.fetch(finalSaveUrl, options);
    const responseText = response.getContentText();
    sendDebugMessage(`SkyService - Этап 3: Ответ от сервера:\n\`\`\`\n${responseText}\n\`\`\``);
    const responseData = JSON.parse(responseText);

    if (responseData.status !== 'done') {
      throw new Error(`Не удалось сохранить данные в черновик. Ответ: ${responseText}`);
    }
    sendDebugMessage(`SkyService - Этап 3 УСПЕШНО. Черновик наполнен данными.`);

  } catch (e) {
    sendDebugMessage(`🔥 ОШИБКА на Этапе 3 (финальный saveDraft): ${e.toString()}`);
    sendPostToTelegram(chatId, "❌ Помилка при збереженні даних накладної в SkyService.");
    editMessageText(chatId, messageId, originalMessageText + "\n\n*(Помилка збереження даних)*");
    return;
  }

  // --- ЭТАП 4: Финализация накладной (addComing) ---
  try {
    sendDebugMessage(`SkyService - Этап 4: Финализация накладной (action=addComing) с draftId: ${draftId} и timezone=${SKY_TIMEZONE}`);
    const comingUrl = `${SKY_API_URL}?action=addComing&section=productMotion&timezone=${SKY_TIMEZONE}&token=${SKY_TOKEN}&device_uuid=${SKY_DEVICE_UUID}&companyId=${companyId}&draftId=${draftId}&tradepointId=${tradePointId}`;

    const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(finalPayload), muteHttpExceptions: true };
    
    sendDebugMessage(`--- ДАННЫЕ ДЛЯ ФИНАЛЬНОГО ЗАПРОСА (addComing) ---\n\n*URL:*\n\`${comingUrl}\`\n\n*Payload:*\n\`\`\`json\n${JSON.stringify(finalPayload, null, 2)}\n\`\`\``);
    
    const response = UrlFetchApp.fetch(comingUrl, options);
    const responseText = response.getContentText();
    sendDebugMessage(`SkyService - Этап 4: Ответ от сервера:\n\`\`\`\n${responseText}\n\`\`\``);
    const responseData = JSON.parse(responseText);

    if (responseData.status === 'done' && responseData.data) {
      const finalInvoiceId = responseData.data;
      sendDebugMessage(`SkyService - Этап 4 УСПЕШНО. Накладная создана с ID: ${finalInvoiceId}`);
      sendPostToTelegram(chatId, `✅ Накладну успішно відправлено в SkyService! ID документа: ${finalInvoiceId}`);
      editMessageText(chatId, messageId, originalMessageText + `\n\n*(✅ Відправлено в SkyService. ID: ${finalInvoiceId})*`);
    } else {
      throw new Error(`Не удалось финализировать накладную. Ответ: ${responseText}`);
    }

  } catch (e) {
    sendDebugMessage(`🔥 ОШИБКА на Этапе 4 (addComing): ${e.toString()}`);
    sendPostToTelegram(chatId, "❌ Помилка при фінальному збереженні накладної в SkyService.");
    editMessageText(chatId, messageId, originalMessageText + "\n\n*(Помилка фінального збереження)*");
  }
}
