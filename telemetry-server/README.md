# telemetry-server

Node 20 + TypeScript service that receives Tesla Fleet telemetry over WebSocket and forwards normalized events to ParkSignal ingest.

## Features

- WebSocket listener on `PORT` (default `8080`)
- HTTP endpoints:
  - `GET /health`
  - `GET /metrics`
- Message parsing for text/binary JSON frames
- Normalized event extraction
- Throttle: max `1 event/sec` per vehicle
- Ingest forwarding to ParkSignal:
  - `POST {PARKSIGNAL_BASE_URL}/api/telemetry/ingest`
  - header `x-telemetry-secret`
  - timeout `5s`
  - retry with exponential backoff (up to 3 attempts) for timeout/5xx

## Environment

Copy `.env.example` and set values:

```bash
PORT=8080
PARKSIGNAL_BASE_URL=https://parking-guard-mnnb.vercel.app
TELEMETRY_INGEST_SECRET=change-me
LOG_LEVEL=info
```

`TELEMETRY_INGEST_SECRET` must match the same value in ParkSignal backend env.

## Local run

```bash
npm install
npm run dev
```

Build + run:

```bash
npm run build
npm start
```

## WebSocket quick test

Use `wscat`:

```bash
npx wscat -c ws://localhost:8080
```

Send sample JSON:

```json
{"vin":"LRW3E7EK1RC988657","timestamp":"2026-03-02T16:00:00Z","latitude":59.34,"longitude":18.06,"speed":0,"shift_state":"P"}
```

Then check:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/metrics
```

## Docker

```bash
docker build -t parksignal-telemetry-server .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e PARKSIGNAL_BASE_URL=https://parking-guard-mnnb.vercel.app \
  -e TELEMETRY_INGEST_SECRET=change-me \
  parksignal-telemetry-server
```

## Deploy hints

- Fly.io: deploy as a standard Node/Docker web service, expose HTTP+WS on the same port.
- Render: use Docker deploy, set env vars in dashboard, health check to `/health`.
