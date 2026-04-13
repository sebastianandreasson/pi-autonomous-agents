# Visualizer UI migration plan

## Goal

Replace inline browser JS/HTML in `src/pi-visualizer-server.mjs` with maintainable React frontend, while keeping Node visualizer server as API + SSE + static asset host.

## Chosen stack

- React
- Vite
- TypeScript
- Zustand
- Plain CSS

## Repo layout

```text
src/
  pi-visualizer-server.mjs   # API, SSE, static asset host
visualizer-ui/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  src/
    main.tsx
    App.tsx
    api.ts
    store.ts
    types.ts
    styles.css
    components/
      TodoList.tsx
      FlowStrip.tsx
      LiveFeed.tsx
      CurrentEdits.tsx
      DiagnosticsPanel.tsx
```

## State model

Zustand store owns:

- latest snapshot
- selected run
- selected todo
- selected event
- feed toggles
- SSE lifecycle
- initial load status / error

## API contract

Current server routes:

- `GET /api/state` → full snapshot
- `GET /api/stream` → SSE full snapshots

Short term: React app consumes current full-snapshot SSE.

Next improvement:

- add monotonic `seq` to live feed entries
- optionally move SSE from full snapshots to patch events
- add snapshot version to ignore stale payloads

## Migration phases

### Phase 1
- scaffold `visualizer-ui/`
- keep current inline HTML as fallback
- add built asset serving from `visualizer-ui/dist`
- add `/api/state` alias

### Phase 2
- port current layout into React components
- use Zustand store + initial snapshot fetch
- use SSE reconnect from frontend

### Phase 3
- move feed/timeline ordering to stable `seq`
- reduce full rerenders
- preserve scroll behavior inside components

### Phase 4
- remove inline browser app from server once built UI covers current features
- keep server only as API/static host

## Dev workflow

Backend + fake live harness:

```bash
npm run debug:live-ui
```

Frontend dev server:

```bash
npm run dev:visualizer:ui
```

Frontend build:

```bash
npm run build:visualizer:ui
```

## Notes

Current state:

- React/Vite/Zustand UI scaffold added
- built assets generated under `visualizer-ui/dist/`
- server serves built UI directly
- legacy inline browser app removed
- fallback page only shows build instructions when dist missing
