# API WhatsApp

Aplicacao unica com:

- API Fastify em `/api/*`
- painel de conversas em `/`
- painel de sessoes e configuracoes em `/sessoes`
- multiplas sessoes/dispositivos de WhatsApp
- QR Code por sessao
- historico de conversas por sessao
- envio e leitura de midia
- webhook configuravel por sessao no painel

## Requisitos

- Node.js 20+
- pasta persistente para `sessions/`
- pasta persistente para `data/`

## Variaveis de ambiente

Use `.env.example` como base:

- `PORT`
- `HOST`
- `RATE_LIMIT_MAX`
- `RATE_LIMIT_WINDOW`
- `BODY_LIMIT_MB`
- `AUTO_CONNECT`
- `SYNC_FULL_HISTORY`
- `SESSIONS_DIR`
- `DATA_DIR`
- `MEDIA_DIR`
- `MAX_STORED_MESSAGES` (`0` = sem limite)
- `WEBHOOK_ENABLED`
- `WEBHOOK_URL`
- `WEBHOOK_SECRET`
- `WEBHOOK_PRIVATE`
- `WEBHOOK_GROUPS`
- `WEBHOOK_NEWSLETTERS`
- `WEBHOOK_BROADCASTS`
- `WEBHOOK_FROM_ME`
- `LOG_LEVEL`

## Rodando localmente

```bash
npm install
cp .env.example .env
npm run dev
```

Abra `http://localhost:3000` para conversas e `http://localhost:3000/sessoes` para QR Code e configuracoes.

## Estrutura de dados

- `sessions/`: autenticacao do WhatsApp por sessao
- `data/sessions.json`: metadados e webhook de cada sessao
- `data/conversations.json`: resumo das conversas por sessao
- `data/messages.json`: historico de mensagens por sessao
- `data/settings.json`: valores padrao para novas sessoes
- `data/media/`: cache local de imagens, videos, audios, stickers e documentos

## Endpoints principais

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/status`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/sessions/:sessionId/settings`
- `PUT /api/sessions/:sessionId/settings`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/connect`
- `POST /api/sessions/:sessionId/disconnect`
- `POST /api/sessions/:sessionId/logout`
- `GET /api/sessions/:sessionId/conversations`
- `GET /api/sessions/:sessionId/conversations/:jid/messages`
- `POST /api/sessions/:sessionId/conversations/:jid/history`
- `POST /api/sessions/:sessionId/conversations/:jid/read`
- `POST /api/sessions/:sessionId/messages/send`
- `GET /api/sessions/:sessionId/media`
