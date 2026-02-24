// =================================================================================
// =                   ФУНКЦИОНАЛ: ОБРАБОТКА НАКЛАДНЫХ                      =
// =================================================================================

/**
 * Вспомогательная функция для выбора оптимального размера фото.
 */
function getOptimalPhotoId(photoArray) {
  const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3 MB

  for (let i = photoArray.length - 1; i >= 0; i--) {
    const photo = photoArray[i];
    if (photo.file_size && photo.file_size < MAX_FILE_SIZE) {
      return photo.file_id;
    }
  }
  return photoArray.length > 0 ? photoArray[0].file_id : null;
}


/**
 * Шаг 1: Запускает процесс обработки накладной.
 */
function startInvoiceProcessing(message) {
  const chatId = message.chat.id;
  sendPostToTelegram(chatId, "🔍 Розпізнаю накладну... Це може зайняти до хвилини.");

  try {
    const fileId = getOptimalPhotoId(message.photo);
    if (!fileId) {
        sendPostToTelegram(chatId, "❌ Не вдалося обробити фото. Спробуйте надіслати його ще раз.");
        return;
    }

    const fileBlob = getFileBlobFromTelegram(fileId);
    const base64Data = Utilities.base64Encode(fileBlob.getBytes());

    const prompt = `Ты — ассистент по обработке документов. Проанализируй это изображение накладной. Извлеки:
- 'supplier' (название поставщика)
- 'total_amount' (итоговая сумма по всей накладной из поля "Разом", как число)
- 'items' (массив товарных позиций)

Для каждой позиции в 'items' верни:
- 'name' (название товара)
- 'quantity' (количество, как число)
- 'unit' (единица измерения, как строка, например "кг", "шт", "л")
- 'sum' (итоговая сумма по этой строке из колонки "Сума", как число). Это самое важное поле.

Верни результат в виде строгого JSON-объекта. Не добавляй комментариев, только JSON.`;

    // ИСПРАВЛЕНИЕ: Заменен вызов несуществующей callGeminiMultimodalAPI на стандартный callGeminiAPI
    const payload = {
      "contents": [{
        "parts": [
          { "text": prompt },
          { "inline_data": { "mime_type": 'image/jpeg', "data": base64Data } }
        ]
      }]
    };
    let recognizedDataJSON = callGeminiAPI(payload);
    // --- Конец исправления ---
    
    if (recognizedDataJSON) {
        const firstBrace = recognizedDataJSON.indexOf('{');
        const lastBrace = recognizedDataJSON.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          recognizedDataJSON = recognizedDataJSON.substring(firstBrace, lastBrace + 1);
        }
    } else {
        throw new Error("Gemini API did not return a valid response.");
    }

    const recognizedData = JSON.parse(recognizedDataJSON);

    const calculatedItemsSum = recognizedData.items.reduce((acc, item) => acc + (item.sum || 0), 0);
    const totalAmountFromDoc = recognizedData.total_amount || 0;

    if (Math.abs(calculatedItemsSum - totalAmountFromDoc) > 1) {
        sendDebugMessage(`🔥 ОШИБКА ВЕРИФИКАЦИИ: Сумма позиций (${calculatedItemsSum}) не сходится с итоговой суммой (${totalAmountFromDoc}).`);
        sendPostToTelegram(chatId, `❌ Помилка перевірки: сума по позиціях (${calculatedItemsSum.toFixed(2)}) не збігається з підсумковою сумою по накладній (${totalAmountFromDoc.toFixed(2)}). Перевірте якість фото.`);
        return;
    }

    const items = recognizedData.items.map(item => {
      let finalPrice = 0;
      if (item.sum && item.quantity) {
        finalPrice = parseFloat((item.sum / item.quantity).toFixed(2));
      }
      return { ...item, final_price: finalPrice, product_id: null, match_status: 'unmatched' };
    });

    const state = { status: 'recognition_complete', supplier: recognizedData.supplier || 'Не знайдено', items: items };
    const stateKey = `invoice_processing_${chatId}_${message.message_id}`;
    CacheService.getScriptCache().put(stateKey, JSON.stringify(state), 21600);

    sendPostToTelegram(chatId, `✅ Накладну розпізнано та перевірено. Постачальник: *${state.supplier}*. Починаю зіставлення з базою...`);
    matchItemsWithAI(state, chatId, stateKey);

  } catch (e) {
    Logger.log(`Ошибка на этапе распознавания накладной: ${e.toString()}`);
    sendDebugMessage(`🔥 ОШИБКА в \`startInvoiceProcessing\`:\n${e.toString()}`);
    sendPostToTelegram(chatId, "❌ Не вдалося розпізнати накладну. Перевірте якість фото та спробуйте ще раз.");
  }
}

/**
 * Шаг 2: Упрощенное сопоставление с базой при помощи ИИ за один проход.
 */
function matchItemsWithAI(state, chatId, stateKey) {
  try {
    const fullNomenclature = getProductNomenclature();
    
    if (!fullNomenclature || fullNomenclature.length === 0) {
        sendPostToTelegram(chatId, "⚠️ Не вдалося завантажити базу товарів (номенклатуру). Подальша обробка неможлива.");
        return;
    }

    const normalizeName = (name) => {
      if (!name) return '';
      return name.toLowerCase().replace(/["'()-\/]/g, ' ').replace(/\s+/g, ' ').trim();
    };

    const normalizedNomenclature = fullNomenclature.map(item => ({
      ...item,
      normalized_name: normalizeName(item.name),
      normalized_synonyms: normalizeName(item.synonyms)
    }));

    const normalizedCurrentItems = state.items.map(item => ({
      ...item,
      normalized_name: normalizeName(item.name)
    }));

    const prompt = `Ты — эксперт по сопоставлению номенклатуры. Твоя задача — максимально точно сопоставить товары из накладной с товарами из базы данных.

Вот товары из накладной (с нормализованным полем 'normalized_name' для сопоставления): ${JSON.stringify(normalizedCurrentItems)}.
А вот ПОЛНЫЙ список товаров из нашей базы данных (также с нормализованными полями): ${JSON.stringify(normalizedNomenclature)}.

Правила сопоставления:
1.  Сравнивай 'normalized_name' из накладной с 'normalized_name' и 'normalized_synonyms' из базы.
2.  Будь очень гибким к совпадениям. Учитывай опечатки, разный порядок слов, транслитерацию (gold/голд), и сокращения ("кава" и "кофе"). Твоя цель — найти логическое соответствие, даже если текст не совпадает на 100%. Например, "кава смажена gold 1кг опт" ДОЛЖНА сопоставиться с "кава gold 1 кг".
3.  Для каждого товара из накладной, который ты уверенно сопоставил, измени в нем два поля: 'product_id' (возьми из базы) и 'match_status' (установи 'matched_by_ai').

Формат ответа:
Верни ПОЛНЫЙ массив объектов из накладной в исходной структуре, но с обновленными полями 'product_id' и 'match_status' для найденных позиций. Только JSON массив, без комментариев и markdown.`;

    const updatedItemsJSON = callGeminiAPI({ "contents": [{ "parts": [{ "text": prompt }] }] });
    
    if (!updatedItemsJSON || updatedItemsJSON.trim() === '') {
      sendPostToTelegram(chatId, '❌ Отримано порожню відповідь від системи аналізу на етапі зіставлення. Спробуйте ще раз.');
      return;
    }

    let parsedItems;
    let jsonString = updatedItemsJSON;
    
    const arrayStartIndex = jsonString.indexOf('[');
    const arrayEndIndex = jsonString.lastIndexOf(']');
    if (arrayStartIndex !== -1 && arrayEndIndex > arrayStartIndex) {
        jsonString = jsonString.substring(arrayStartIndex, arrayEndIndex + 1);
    }

    jsonString = jsonString.replace(/\u00A0/g, ' ');

    try {
      parsedItems = JSON.parse(jsonString);
    } catch (jsonError) {
      sendPostToTelegram(chatId, '❌ Системі аналізу не вдалося повернути коректні дані для зіставлення. Спробуйте ще раз.');
      return;
    }

    if (!Array.isArray(parsedItems)) {
      sendPostToTelegram(chatId, '❌ Система аналізу повернула дані в неочікуваному форматі. Спробуйте ще раз.');
      return;
    }
    
    state.items = parsedItems;
    state.status = 'matching_complete';
    CacheService.getScriptCache().put(stateKey, JSON.stringify(state), 21600);

    presentForReview(state, chatId, stateKey);

  } catch (e) {
    Logger.log(`Ошибка на этапе сопоставления с ИИ: ${e.toString()}`);
    sendDebugMessage(`🔥 ОШИБКА в \`matchItemsWithAI\`:\n${e.toString()}`);
    sendPostToTelegram(chatId, `❌ Сталася помилка під час зіставлення товарів з базою: ${e.message}`);
  }
}


/**
 * Шаг 3: Отображение списка для проверки и запроса коррекции.
 */
function presentForReview(state, chatId, stateKey) {
  const fullNomenclature = getProductNomenclature();
  let messageText = "*Перевірка зіставлення:*\nБудь ласка, перевірте результати.\n\n";
  
  state.items.forEach((item, index) => {
    messageText += `*${index + 1}.* `;
    if (item.match_status === 'matched_by_ai') {
      const matchedProduct = fullNomenclature.find(p => p.product_id == item.product_id);
      messageText += `🤖 *Зіставлено:*\n`;
      messageText += `   • *З накладної:* \`${item.name}\`\n`;
      messageText += `   • *З базою:* \`${matchedProduct ? matchedProduct.name : 'ПОМИЛКА: ID не знайдено'}\` (ID: ${item.product_id})\n\n`;
    } else { // unmatched
      messageText += `❓ *Не знайдено:*\n`;
      messageText += `   • *З накладної:* \`${item.name}\`\n\n`;
    }
  });

  messageText += "Якщо все вірно, натисніть *✅ Все вірно, далі*.\n";
  messageText += "Якщо є помилки, натисніть *✏️ Виправити помилки*.";

  const inlineKeyboard = {
    inline_keyboard: [[
      { text: "✅ Все вірно, далі", callback_data: `confirm_review_${stateKey}` },
      { text: "✏️ Виправити помилки", callback_data: `edit_errors_${stateKey}` }
    ]]
  };

  const sentMessage = sendPostToTelegram(chatId, messageText, null, null, inlineKeyboard);
  if (sentMessage && sentMessage.result && sentMessage.result.message_id) {
    const newKey = `invoice_processing_${chatId}_${sentMessage.result.message_id}`;
    CacheService.getScriptCache().remove(stateKey);
    CacheService.getScriptCache().put(newKey, JSON.stringify(state), 21600);
  }
}

/**
 * Шаг 3.1: Запрос деталей для коррекции.
 */
function askForCorrectionDetails(chatId, stateKey) {
  const messageText = "Будь ласка, **дайте відповідь на це повідомлення**, вказавши номер позиції та правильний ID у форматі: `номер - ID`.\nНаприклад: `1 - 123, 2 - 456`";
  const sentMessage = sendPostToTelegram(chatId, messageText);
  if (sentMessage && sentMessage.result && sentMessage.result.message_id) {
    const stateJSON = CacheService.getScriptCache().get(stateKey);
    const newKey = `invoice_processing_${chatId}_${sentMessage.result.message_id}`;
    CacheService.getScriptCache().remove(stateKey);
    CacheService.getScriptCache().put(newKey, stateJSON, 21600);
  }
}

/**
 * Шаг 4: Обработка ответа от пользователя с коррекциями.
 */
function handleUserCorrection(message, stateKey, state) {
  const chatId = message.chat.id;
  const userText = message.text;
  try {
    // УЛУЧШЕНИЕ: Используем Regex для надежного парсинга формата "номер - ID"
    const correctionRegex = /(\d+)\s*-\s*(\S+)/g;
    let match;
    let hasCorrections = false;

    while ((match = correctionRegex.exec(userText)) !== null) {
      hasCorrections = true;
      const itemIndex = parseInt(match[1], 10) - 1;
      const productId = match[2];

      if (itemIndex >= 0 && itemIndex < state.items.length) {
        state.items[itemIndex].product_id = productId;
        state.items[itemIndex].match_status = 'matched_by_user';
        updateSynonyms(productId, state.items[itemIndex].name);
      }
    }

    if (!hasCorrections) throw new Error("Формат не распознан.");
    
    presentForReview(state, chatId, stateKey);
    
  } catch (e) {
    Logger.log(`Ошибка при обработке коррекции от пользователя: ${e.toString()}`);
    sendDebugMessage(`🔥 ОШИБКА в \`handleUserCorrection\`:\n${e.toString()}`);
    sendPostToTelegram(chatId, "❌ Не вдалося обробити вашу відповідь. Перевірте формат та спробуйте ще раз.");
  }
}

/**
 * Шаг 5: Выбор торговой точки.
 */
function presentTradePointSelection(state, chatId, stateKey, fromId) {
  const userAccess = getUserAccess(fromId); // Теперь возвращает { points: [...], workerId: ... }

  if (!userAccess || !userAccess.points || !userAccess.points.length === 0) {
    sendPostToTelegram(chatId, "❌ У вас немає доступу до жодної торгової точки. Зверніться до адміністратора.");
    return;
  }

  // Сохраняем ID работника в состояние для последующего использования
  state.workerId = userAccess.workerId;
  CacheService.getScriptCache().put(stateKey, JSON.stringify(state), 21600);

  const keyboard = userAccess.points
    .filter(pointKey => TRADE_POINTS_CONFIG[pointKey]) // Убедимся, что точка настроена
    .map(pointKey => {
      const pointName = TRADE_POINTS_CONFIG[pointKey].name || `Точка #${pointKey}`; // Берем имя из конфига
      // В callback_data передаем уникальный текстовый ключ
      const callback_data = `select_tradepoint_${pointKey}_${stateKey.split('_').slice(2).join('_')}`;
      return [{ text: pointName, callback_data: callback_data }];
    });
  
  if (keyboard.length === 0) {
      sendPostToTelegram(chatId, "❌ Вам надано доступ до торгових точок, але вони не налаштовані в боті. Зверніться до адміністратора.");
      return;
  }

  const messageText = "В яку кав'ярню внести накладну?";
  const inlineKeyboard = { inline_keyboard: keyboard };
  sendPostToTelegram(chatId, messageText, null, null, inlineKeyboard);
}

/**
 * Шаг 6: Отображение финального списка и кнопки подтверждения.
 */
function presentFinalConfirmation(state, chatId, stateKey) {
  try {
    const escapeMarkdown = (text) => {
        if (!text) return '';
        return text.toString().replace(/[*_`]/g, '\\$&');
    };

    let messageText = `*Готово до відправки в облікову систему:*\n\n`;
    messageText += `*Постачальник:* ${escapeMarkdown(state.supplier)}\n`;
    // ИСПРАВЛЕНИЕ: Используем правильный ключ 'selectedTradePointKey' вместо 'selectedTradePointId'
    messageText += `*Торгова точка:* ${TRADE_POINTS_CONFIG[state.selectedTradePointKey].name}\n\n`;
    
    let totalSum = 0;

    state.items.forEach(item => {
      const statusIcon = item.match_status === 'matched_by_ai' ? '🤖' : '👤';
      const price = item.final_price || 0;
      const quantity = item.quantity || 0;
      const unit = item.unit || 'од.';
      const itemSum = item.sum || 0;
      totalSum += itemSum;

      messageText += `${statusIcon} *${escapeMarkdown(item.name)}* (ID: ${item.product_id})\n`;
      messageText += `   ${quantity} ${unit} × ${price.toFixed(2)} грн = *${itemSum.toFixed(2)} грн*\n`;
    });

    messageText += `\n*Разом до сплати: ${totalSum.toFixed(2)} грн*\n`;
    messageText += `\nНатисніть кнопку нижче для відправки в SkyService.`;

    const callbackData = `send_to_skyservice_${stateKey}`;
    
    const inlineKeyboard = {
      inline_keyboard: [[
        { text: "🚀 Відправити в SkyService", callback_data: callbackData }
      ]]
    };

    sendPostToTelegram(chatId, messageText, null, null, inlineKeyboard);
  } catch (e) {
    Logger.log(`Ошибка в presentFinalConfirmation: ${e.toString()}`);
    sendDebugMessage(`🔥 КРИТИЧЕСКАЯ ОШИБКА в \`presentFinalConfirmation\`:\n${e.toString()}\nСостояние: ${JSON.stringify(state)}`);
  }
}
