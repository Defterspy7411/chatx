# ChatX

ChatX is a real-time chat app built with Node.js, Express, Socket.IO, and plain HTML/CSS/JavaScript.

## Current features

- Signup and login with password hashing
- Direct messages and group chat
- Admin and leader permissions
- Join requests and invite links
- Edit messages
- Message ticks and last seen
- Unread counts
- Chat search and message search
- Light and dark mode
- Session restore on refresh
- Postgres support for production storage

## Run locally

```powershell
npm install
npm start
```

Open `http://127.0.0.1:3000`.

By default, local development uses:

- `data/chat-data.json`

If you set `DATABASE_URL`, the app will use Postgres instead.

## Render prep

This repo includes `render.yaml` for a basic Render web service setup.

### Important

For production, use Postgres with `DATABASE_URL`.

If `DATABASE_URL` is not set, the app falls back to `data/chat-data.json`, which is fine locally but not reliable for deployed chat data.

## Render deployment

1. Push this project to GitHub.
2. Create a new Render Web Service from the repo.
3. Render will detect `render.yaml`.
4. Add environment variables:
   - `DATABASE_URL`
   - `POSTGRES_SSL=true`
5. Deploy the service.

## Data model right now

- Local mode: one JSON file at `data/chat-data.json`
- Production mode: one JSONB app-state record in Postgres

This is much safer for deployment than local files and keeps the current app logic simple.

## Recommended next data upgrade

For a bigger production app, the next step is a normalized Postgres schema:

1. `users`
2. `groups`
3. `group_members`
4. `group_requests`
5. `messages`
6. `direct_chats`
7. `message_status`

That will make search, unread counts, analytics, and scaling much better later.
