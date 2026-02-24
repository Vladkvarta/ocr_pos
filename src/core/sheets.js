// =================================================================================
// =                          DATA: GOOGLE SHEETS                                  =
// =================================================================================

/**
 * Обработка сканирования RFID-меток.
 */
function handleRfidScan(uid) {
  const employee = getEmployeeByUid(uid);
  if (!employee) {
    Logger.log(`Получен неизвестный RFID UID: ${uid}`);
    return;
  }
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TIME_LOG_SHEET_NAME);
    if (!sheet) {
      const newSheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(TIME_LOG_SHEET_NAME);
      newSheet.getRange("A1:B1").setValues([["Месяц (ГГГГ-ММ)", "Данные JSON"]]).setFontWeight("bold");
    }
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const dayOfMonth = now.getDate();
    const currentTime = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;
    let monthDb = {};
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] == monthKey) {
        rowIndex = i + 1;
        try { monthDb = JSON.parse(data[i][1] || '{}'); } catch (jsonErr) { monthDb = {}; }
        break;
      }
    }
    if (!monthDb[employee.name]) monthDb[employee.name] = {};
    if (!monthDb[employee.name][dayOfMonth]) monthDb[employee.name][dayOfMonth] = { "пришел": "", "ушел": "" };
    const dayData = monthDb[employee.name][dayOfMonth];
    let messageToUser = '';
    if (!dayData["пришел"]) {
      dayData["пришел"] = currentTime;
      messageToUser = `Привіт, ${employee.name}! Ваш прихід о ${currentTime} зареєстровано.`;
    } else {
      dayData["ушел"] = currentTime;
      messageToUser = `Бувайте, ${employee.name}! Ваш ухід о ${currentTime} зареєстровано.`;
    }
    if (employee.telegramId) { sendPostToTelegram(employee.telegramId, messageToUser); }
    const updatedDbString = JSON.stringify(monthDb);
    if (rowIndex !== -1) {
      sheet.getRange(rowIndex, 2).setValue(updatedDbString);
    } else {
      sheet.appendRow([monthKey, updatedDbString]);
    }
  } catch (e) {
    Logger.log(`Ошибка при логировании времени для UID ${uid}: ${e.toString()}`);
  }
}


/**
 * Получает данные сотрудника по его RFID UID.
 */
function getEmployeeByUid(uid) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'staff_database';
  let staffDb = JSON.parse(cache.get(cacheKey) || 'null');
  if (!staffDb) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STAFF_SHEET_NAME);
    if (!sheet) {
      Logger.log(`Ошибка: лист с именем "${STAFF_SHEET_NAME}" не найден.`);
      return null;
    }
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    staffDb = {};
    data.forEach(row => {
      const [staffUid, name, telegramId] = row;
      if (staffUid) {
        staffDb[staffUid] = { name: name, telegramId: telegramId };
      }
    });
    cache.put(cacheKey, JSON.stringify(staffDb), 3600);
  }
  return staffDb[uid] || null;
}

/**
 * Проверяет, зарегистрирован ли чат/тема, и добавляет их в лог, если нет.
 */
function checkAndRegisterLocation(chatId, chatTitle, threadId, chatType, fromName) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
    if (!sheet) {
      const newSheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(LOG_SHEET_NAME);
      newSheet.getRange("A1").setValue("Данные о чате (название:id:имя:id_темы)");
    }
    const range = sheet.getRange(1, 1, sheet.getLastRow(), 1);
    const values = range.getValues();
    let isFound = false;
    for (let i = 0; i < values.length; i++) {
      if (values[i][0]) {
        const parts = values[i][0].split(':');
        if (parts.length >= 4) {
          const storedChatId = parts[1];
          const storedThreadId = parts[3];
          const currentThreadId = (chatType === 'private') ? 'ЛС' : (threadId || 0).toString();
          if (storedChatId == chatId && storedThreadId == currentThreadId) {
            isFound = true;
            break;
          }
        }
      }
    }
    if (!isFound) {
      let dataForSheet;
      if (chatType === 'private') {
        dataForSheet = `ЛС:${chatId}:${fromName || 'Користувач'}:ЛС`;
      } else {
        const topicNamePlaceholder = 'НАЗВАНИЕ_ТЕМЫ';
        dataForSheet = `${chatTitle}:${chatId}:${topicNamePlaceholder}:${threadId || 0}`;
      }
      sheet.appendRow([dataForSheet]);
    }
  } catch (e) {
    Logger.log(`Ошибка при регистрации местоположения: ${e.toString()}`);
  }
}

/**
 * Получает номенклатуру товаров из таблицы.
 */
function getProductNomenclature(supplier, getOthers = false) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Номенклатура');
    if (!sheet) return null;

    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    let products = data.map(row => ({
      product_id: row[0] || '',
      name: row[1] || '',
      synonyms: row[2] || '',
      supplier: row[3] || ''
    })).filter(p => p.product_id && p.name);

    if (supplier && supplier !== 'Не знайдено') {
      if (getOthers) {
        return products.filter(p => p.supplier !== supplier);
      } else {
        return products.filter(p => p.supplier === supplier);
      }
    }
    
    return getOthers ? [] : products;

  } catch (e) {
    Logger.log(`Не вдалося завантажити номенклатуру: ${e.toString()}`);
    return null;
  }
}

/**
 * Получает список доступных торговых точок для пользователя.
 * @param {string|number} chatId - ID пользователя в Telegram.
 * @returns {Array|null} - Массив ключей доступных торговых точок или null, если доступ не найден.
 */
function getUserAccess(chatId) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('UserAccess');
    if (!sheet) {
      sendDebugMessage("🔥 ОШИБКА: Лист 'UserAccess' не найден.");
      return null; // Возвращаем null, если лист не найден
    }
    // Расширяем диапазон, чтобы захватить 4-й столбец (workerId)
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] == chatId) {
        const allowedPoints = data[i][2].toString().split(',').map(s => s.trim());
        const workerId = data[i][3]; // Получаем ID работника из 4-й колонки
        return {
          points: allowedPoints,
          workerId: workerId || 1 // Возвращаем 1 по умолчанию, если не указано
        };
      }
    }
    return null; // Возвращаем null, если пользователь не найден
  } catch(e) {
    sendDebugMessage(`🔥 ОШИБКА в getUserAccess: ${e.toString()}`);
    return null;
  }
}

/**
 * Добавляет новый синоним к товару в таблице "Номенклатура".
 * @param {string|number} productId - ID товара, которому нужно добавить синоним.
 * @param {string} newSynonym - Новый синоним для добавления.
 */
function updateSynonyms(productId, newSynonym) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Номенклатура');
    if (!sheet) return;

    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] == productId) {
        let currentSynonyms = data[i][2] || '';
        // Проверяем, чтобы не добавлять дубликат
        if (!currentSynonyms.includes(newSynonym)) {
          const updatedSynonyms = currentSynonyms ? `${currentSynonyms}, ${newSynonym}` : newSynonym;
          sheet.getRange(i + 2, 3).setValue(updatedSynonyms);
          sendDebugMessage(`✅ Синоним "${newSynonym}" добавлен к товару с ID ${productId}.`);
        }
        return;
      }
    }
  } catch(e) {
    sendDebugMessage(`🔥 ОШИБКА в updateSynonyms: ${e.toString()}`);
  }
}