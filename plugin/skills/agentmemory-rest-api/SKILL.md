---
name: agentmemory-rest-api
description: The agentmemory HTTP REST API surface, the primary protocol for talking to the memory server. Use when calling agentmemory over HTTP, when MCP is unavailable and you need a fallback, or when integrating a host that does not speak MCP.
user-invocable: false
---

REST is agentmemory's primary surface. MCP is a bridge on top of it. Every memory operation has an HTTP endpoint under `http://localhost:3111/agentmemory/*`.

## Quick start

```bash
# liveness
curl -fsS http://localhost:3111/agentmemory/livez

# save
curl -X POST http://localhost:3111/agentmemory/remember \
  -H "Content-Type: application/json" \
  -d '{"content":"chose JWT refresh rotation","concepts":["jwt-refresh-rotation"]}'

# recall
curl -X POST http://localhost:3111/agentmemory/smart-search \
  -H "Content-Type: application/json" \
  -d '{"query":"auth token strategy","limit":5}'
```

## Auth

By default localhost is open and no auth is needed. When `AGENTMEMORY_SECRET` is set, every request needs `Authorization: Bearer $AGENTMEMORY_SECRET`. See agentmemory-config.

## Conventions

- Save returns `201`, reads return `200`, validation errors return `400`.
- Handlers whitelist body fields and drop unknown ones, so passing extra keys is safe but ignored.
- The port is configurable with `--port` or `--instance`; streams, viewer, and engine derive from it.

## Task-style APIs

Some extraction and build operations are durable tasks: create the task, process bounded work, then poll status.

Graph build task:

1. `POST /agentmemory/graph/build` creates a graph build task and returns a task id.
2. `POST /agentmemory/graph/build/process` advances queued or running graph build work.
3. `GET /agentmemory/graph/build/task?taskId=...` reads task status, progress, lease, cursor, and visibility.

The lessons extraction flow:

1. `POST /agentmemory/lessons/extract` creates one extraction run per explicit `sessionIds` entry.
2. `POST /agentmemory/lessons/extract/process` advances bounded extraction work.
3. `GET /agentmemory/lessons/extract/runs` lists extraction runs.
4. `GET /agentmemory/lessons/extract/run?runId=...` reads one run status.

These flows are REST-only unless an MCP tool in agentmemory-mcp-tools explicitly documents an equivalent.

## See also

- agentmemory-mcp-tools for the MCP equivalents.
- agentmemory-config for the port quartet and the secret.

## Reference

The full endpoint list with methods lives in REFERENCE.md, generated from `src/triggers/api.ts`.
