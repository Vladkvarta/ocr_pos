// =================================================================================
// =                          ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И НАСТРОЙКИ                     =
// =================================================================================

// --- Получение секретных ключей из PropertiesService ---
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
const TELEGRAM_BOT_TOKEN = SCRIPT_PROPERTIES.getProperty('TELEGRAM_BOT_TOKEN');
const GEMINI_API_KEY = SCRIPT_PROPERTIES.getProperty('GEMINI_API_KEY');

// --- Telegram ---
const BOT_USERNAME = 'Smakuie_Bot';
const tgBotUrl = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN;
const hookUrl = 'https://script.google.com/macros/s/';
const DEBUG_CHAT_ID = ''; // ID для получения логов

// --- Gemini AI ---
const GEMINI_MODEL_NAME = 'gemini-1.5-flash'; 

// --- Google Sheets ---
const STAFF_SHEET_NAME = 'Сотрудники';
const LOG_SHEET_NAME = 'SmakuieBot_Log';
const TIME_LOG_SHEET_NAME = 'Учет Времени';

// --- SkyService ---
const SKY_TOKEN = "824E5BhNSK37TTK9Zr96Zr4HBtFzRNHe";
const SKY_DEVICE_UUID = "";
const SKY_API_URL = "https://xn-l3h.api.skyservice.online/";
const SKY_TIMEZONE = -3; // Часовой пояс для запросов в SkyService

// --- Конфигурация торговых точек ---
// Ключ объекта - это уникальный текстовый идентификатор, который вы будете использовать в таблице доступов.
const TRADE_POINTS_CONFIG = {
  "1": { 
    name: "Maybe Coffee", 
    companyId: "", 
    tradePointId: 2,
    warehouseId: 2 
  },
  "2": { 
    name: "Смакує", 
    companyId: "", // ID Компании 1
    tradePointId: 3, 
    warehouseId: 4 
  },
  "3": {
    name: "Цех",
    companyId: "", // ID Компании 2
    tradePointId: 1, 
    warehouseId: 1
  }
};

// --- Вспомогательные функции ---

function setWebHook() {
  let response = UrlFetchApp.fetch(tgBotUrl + "/setWebhook?url=" + hookUrl);
  Logger.log('telegram response status is ' + response.getResponseCode());
}