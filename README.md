# DagmarCom Backend

Backend obsluhuje WhatsApp webhook, frontu dotazu, volani OpenAI Responses API a spravu nastaveni.

## Rychly start
1. `cp .env.example .env` a dopln `OPENAI_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
2. `npm install`
3. `npm run dev` pro vyvoj, `npm start` pro produkci.
4. Webhook nastavte na `https://api.hcasc.cz/webhook/whatsapp`.

## API
- `POST /webhook/whatsapp` – prijem zprav z WhatsApp. Ocekava telo Meta webhooku, extrahuje `from` a `text.body`.
- `GET/POST /api/settings` (Basic Auth admin/+Sin8glov8) – nacteni/ulozeni nastaveni (autoEnabled, trifazove instructions/role/context/inputSuffix, outputPrefix*, openaiApiKey, openaiModel).
- `GET /api/logs` (Basic Auth) – filtrace logu podle telefonu, fulltextu, casu.
- `GET /api/logs/chat?phone=...` (Basic Auth) – export chatu ve formatu JSON nebo text/plain.
- `GET /api/status` (Basic Auth) – semafory: API key, WhatsApp, DB, system, posledni IN/OUT/AI a recentni chyby (response_id/oa).
- `POST /api/status/test/openai` (Basic Auth) – rychly ping na OpenAI Responses API (pouziva previous_response_id pro kontinuitu).
- `POST /api/status/test/whatsapp` (Basic Auth) – ovreni pristupu k WhatsApp API (Graph). 
- `POST /api/status/test/whatsapp/send` (Basic Auth) – odeslani testovaci zpravy na zadane cislo (pro ovreni konektivity).
- `GET /delete?phone=...` – okamzite smazani vsech dat pro telefon (Del URL pro GDPR).
- `GET /health` – status.

## Logovani
Pino zapisuje do `logs/app.log` a do konzole. Tabulka `logs` v SQLite uchovava vsechny request/response payloady.

## Fronta a SLA
- Zpravy jednoho cisla se zpracovavaji sekvencne, kumuluji se do jednoho dotazu na OpenAI.
- Pokud prijde dalsi zprava do 8 hodin, pouziva se `previous_response_id` (kontinuita konverzace dle Responses API 2025). Po 8 h se posila GDPR notifikace a vlákno se restartuje.
- Po odeslani odpovedi jsou cekajici zpravy slouceny do dalsiho dotazu.
- Chyby OpenAI (napr. spatny response_id) se loguji do tabulky `logs` s direction `ERROR` a zobrazuji se na dashboardu /status (semafor cerveny pri poslednich chybach).

## Testy
`npm test` spusti jest (ukazkovy test pro format odpovedi). Provoz na produkcnich datech – testy spoustejte jen v sandboxu podle interni politiky.

## Nasazeni
Aplikace bezi na Node 18+. Server posloucha na `PORT` (default 8080). Pro Nginx nastavte reverzni proxy a HTTPS na `api.hcasc.cz`.
