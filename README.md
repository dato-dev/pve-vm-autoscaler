# pve-vm-autoscaler

[![CI](https://github.com/dato-dev/pve-vm-autoscaler/actions/workflows/ci.yml/badge.svg)](https://github.com/dato-dev/pve-vm-autoscaler/actions/workflows/ci.yml)

`pve-vm-autoscaler` — MVP autoscaler для Proxmox. Агент запускается внутри flexible VM, отправляет CPU/RAM/disk метрики на сервер, сервер хранит временные ряды в TimescaleDB и создаёт новую VM через Proxmox API, если нагрузка держится выше заданного порога.

## Условия применимости

Автоскейлер управляет количеством VM. Сам по себе он не доставляет трафик на новую машину
и не устанавливает на неё приложение — это должно быть решено рядом, иначе scale-up создаст
пустую VM, а нагрузка не снизится.

**1. Шаблон должен нести рабочую нагрузку.** `templateVmId` в политике — это VM, из которой
делается клон. В ней уже должны стоять и приложение, и агент, чтобы новая машина начинала
обслуживать сразу после загрузки. Установка пакетов при старте съедает минуты ровно тогда,
когда ёмкость нужна немедленно.

**2. Пул должен быть stateless.** Ноды считаются взаимозаменяемыми и могут быть удалены
в любой момент. Сессии — в Redis или в подписанную куку, загружаемые файлы — в общее хранилище
или S3. Сервис, хранящий состояние локально, горизонтально не масштабируется, и балансировщик
этого не исправит.

**3. Трафик до ноды доставляет что-то другое.** Здесь всё зависит от типа нагрузки:

| Тип нагрузки | Что нужно рядом |
|---|---|
| Воркеры очередей, CI-раннеры | **ничего** — нода сама забирает работу из очереди |
| Веб-сервис, API | балансировщик с health-check'ами: HAProxy, Traefik, nginx |

Pull-нагрузки проще всего: новая VM подключается к очереди и начинает разбирать задачи,
никакой регистрации не требуется.

### Референсная схема для веб-сервиса

```mermaid
flowchart TB
  VIP["Плавающий IP<br/>keepalived / VRRP"]
  LB["HAProxy / Traefik<br/>health checks"]
  W1["worker-1<br/>приложение + агент"]
  W2["worker-2<br/>приложение + агент"]
  W3["worker-3<br/>создан автоскейлером"]
  AS["pve-vm-autoscaler"]
  TPL[("VM template<br/>приложение + агент")]

  VIP --> LB
  LB -->|"трафик только после health check"| W1 & W2 & W3
  AS -.->|"состав пула"| LB
  W1 & W2 & W3 -->|"метрики"| AS
  AS -->|"clone"| TPL
  TPL -.->|"новая VM"| W3
```

Балансировщик сам не масштабируется и остаётся точкой отказа — отсюда пара узлов
с плавающим IP. Health-check'и делает он же: автоскейлер не проверяет готовность приложения
и не должен, у балансировщиков это уже есть.

Публикация состава пула для балансировщика запланирована в Milestone 6, разбор решения —
в ADR-4 в [ROADMAP.md](ROADMAP.md). Сейчас список нод придётся поддерживать вручную.

## Архитектура

### Текущая MVP-схема

В текущей реализации сервер считает только active-ноды, которые уже прислали хотя бы одну метрику. Новая VM начинает учитываться в `maxNodes` только после старта агента и первого успешного `POST /v1/metrics`.

```mermaid
sequenceDiagram
  participant Agent as Active VM Agent
  participant Server as Autoscaler Server
  participant DB as TimescaleDB
  participant Evaluator as Scaling Evaluator
  participant Proxmox as Proxmox API
  participant NewAgent as New VM Agent

  Agent->>Server: 1. POST /v1/metrics
  Server->>DB: 2. Upsert node and insert metrics
  Evaluator->>DB: 3. Read avg load and knownNodes
  DB-->>Evaluator: 4. knownNodes = active nodes only
  Evaluator->>Evaluator: 5. Check load threshold and knownNodes < maxNodes
  Evaluator->>Proxmox: 6. Clone/start VM
  Proxmox-->>Evaluator: 7. VM created
  Note over Evaluator,NewAgent: New VM is not counted yet because its agent has not sent metrics
  NewAgent->>Server: 8. POST /v1/metrics after boot
  Server->>DB: 9. New VM becomes known node
```

Минус этой схемы: пока `New VM` не подняла агент и не отправила метрики, сервер её не видит как known node. Если нагрузка остаётся высокой и `cooldownSeconds` маленький, сервер может создать ещё одну VM до того, как первая новая VM появится в таблице `nodes`.

### Целевая схема

```mermaid
sequenceDiagram
  participant Agent as Active VM Agent
  participant Server as Autoscaler Server
  participant DB as TimescaleDB
  participant Evaluator as Scaling Evaluator
  participant Proxmox as Proxmox API
  participant NewAgent as New VM Agent

  Agent->>Server: 1. POST /v1/metrics
  Server->>DB: 2. Upsert node and insert metrics
  Evaluator->>DB: 3. Read avg load, activeNodes, provisioningNodes
  DB-->>Evaluator: 4. activeNodes + provisioningNodes
  Evaluator->>Evaluator: 5. Calculate effectiveNodes
  alt effectiveNodes >= maxNodes
    Evaluator->>Evaluator: 6. Skip scale-up
  else effectiveNodes < maxNodes and load is high
    Evaluator->>DB: 6. Create scaling_event status provisioning
    Evaluator->>Proxmox: 7. Clone/start VM
    Proxmox-->>Evaluator: 8. VM created
    Evaluator->>DB: 9. Store createdVmId and taskId
    Note over Evaluator,NewAgent: New VM is already counted as provisioning
    NewAgent->>Server: 10. POST /v1/metrics after boot
    Server->>DB: 11. Mark VM as active/known node
  end
```

`maxNodes` должен ограничивать не только ноды, которые уже шлют метрики, но и VM в процессе provisioning. Иначе при долгом старте новой VM сервер может видеть только старые active nodes и создать лишние VM. Целевая модель: `effectiveNodes = activeNodes + provisioningNodes`. В текущем MVP `cooldownSeconds` снижает риск, но production-логика должна учитывать pending/provisioning scaling events как часть лимита.

## Компоненты

- `apps/agent`: сборщик CPU/RAM/disk метрик и push-клиент для `/v1/metrics`.
- `apps/server`: Fastify API, auth, миграции БД, evaluator и scaling events.
- `packages/shared`: Zod-схемы и TypeScript-типы для контрактов.
- `packages/proxmox`: клиент Proxmox API с dry-run, clone/start flow и polling task.
- `infra/policy.example.yaml`: пример scaling policy.

## Локальный запуск

1. Установить зависимости:

```bash
npm install
```

2. Скопировать env:

```bash
cp .env.example .env
```

3. Поднять TimescaleDB и сервер в dry-run режиме:

```bash
docker compose up --build
```

4. Запустить агента локально в отдельном терминале:

```bash
AGENT_TOKEN=change-me \
AGENT_SERVER_URL=http://localhost:8080 \
AGENT_LABELS=role=worker,env=dev \
npm run dev:agent
```

Сервер по умолчанию запускает миграции при старте. В dry-run режиме scaling event будет записан в БД, но VM в Proxmox создана не будет.

## Деплой: сервер локально, агент на CentOS/RHEL VM

Этот сценарий подходит, если твоя машина и тестовая VM находятся в одной LAN и VM может открыть `http://<your-lan-ip>:8080`.

1. На машине с сервером узнай LAN IP:

```bash
ipconfig getifaddr en0
```

Если используется не Wi-Fi интерфейс, проверь IP через `ifconfig` или системные настройки сети.

2. Подними сервер так, чтобы он слушал LAN:

```bash
cp .env.example .env
docker compose up --build
```

В `docker-compose.yml` сервер уже публикует `8080:8080`, а `SERVER_HOST` выставлен в `0.0.0.0`.

3. Проверь с VM, что сервер доступен:

```bash
curl http://<your-lan-ip>:8080/health
```

Ожидаемый ответ:

```json
{"ok":true,"service":"pve-vm-autoscaler-server"}
```

4. Скопируй проект на VM:

```bash
rsync -a --exclude node_modules --exclude dist ./ root@<vm-ip>:/tmp/pve-vm-autoscaler/
```

5. На VM установи агент как systemd service:

```bash
ssh root@<vm-ip>
cd /tmp/pve-vm-autoscaler
sudo AGENT_SERVER_URL=http://<your-lan-ip>:8080 \
  AGENT_TOKEN=change-me \
  AGENT_NODE_ID=test-vm-1 \
  AGENT_LABELS=role=worker,env=test \
  bash scripts/install-agent-rhel.sh
```

6. Проверь агент:

```bash
systemctl status pve-vm-autoscaler-agent --no-pager
journalctl -u pve-vm-autoscaler-agent -f
```

Если в логах агента есть `metrics sent`, сервер получает метрики. Если VM не достучалась до сервера, проверь firewall на машине с сервером и разреши входящий TCP `8080` в LAN.

## HTTP API

### `GET /health`

Без аутентификации.

```json
{"ok":true,"service":"pve-vm-autoscaler-server"}
```

### `POST /v1/metrics`

Приём снимка метрик от агента. Требует заголовок `Authorization: Bearer <AGENT_TOKEN>`.

| Код | Когда | Тело |
|---|---|---|
| `202` | Снимок принят и записан | `{"accepted":true}` |
| `400` | Payload не прошёл валидацию | `{"error":"invalid_metrics_payload","issues":[{"path":"cpu.usagePercent","message":"..."}]}` |
| `401` | Токен отсутствует или неверен | `{"error":"unauthorized"}` |

`400` возвращается с перечнем полей, не прошедших проверку, — это ошибка клиента,
и повторять такой запрос бессмысленно. Агент уходит в backoff только на `5xx` и сетевых сбоях.

## Конфигурация policy

Пример — [`infra/policy.example.yaml`](infra/policy.example.yaml). Файл разделён по частоте
изменения: `nodeTemplates` описывает, **что** создавать, и правится редко; `policies` описывает,
**когда** масштабировать, и тюнится постоянно. Один шаблон могут использовать несколько политик.

```yaml
version: 1

nodeTemplates:
  worker:
    hypervisor: proxmox      # нода Proxmox, а не воркер-VM
    templateVmId: 100
    cpu: 2                   # ядра
    memory: 2Gi
    disk: 20Gi
    diskDevice: virtio0

policies:
  - name: default-workers
    template: worker
    selector:
      role: worker
    nodes: { min: 1, max: 5 }
    window: 2m               # окно усреднения нагрузки
    scaleUp:
      cpu: 60%
      memory: 80%
      cooldown: 5m
```

Единица измерения видна в самом значении: `5m` и `1h30m` для длительностей, `2Gi` и `512Mi`
для объёмов, `60%` для порогов. Знак процента обязателен — в файле рядом стоят `cpu: 2` (ядра)
и `cpu: 60%` (порог), и без суффикса они читались бы одинаково.

Проверить файл, не поднимая сервер и не требуя базы:

```bash
npm run policy:validate -- infra/policy.example.yaml
```

Перевести политику старого формата (плоский JSON до версии 1) в новый:

```bash
npm run policy:convert -- old-policy.json > policy.yaml
```

Конвертер валидирует результат перед выводом. Значения переносятся без потери смысла:
`memoryMb: 2048` становится `memory: 2048Mi`, а не мегабайтами.

## Proxmox

Для реального создания VM нужно выключить dry-run и задать токен:

```bash
PROXMOX_DRY_RUN=false
PROXMOX_BASE_URL=https://pve.example.com:8006
PROXMOX_TOKEN_ID=root@pam!autoscaler
PROXMOX_TOKEN_SECRET=...
```

Текущий MVP создаёт VM через clone template, применяет CPU/RAM/tags, при необходимости resize `virtio0`, запускает VM и ждёт завершения Proxmox task.

## Проверки

```bash
npm install
npm run build
npm test
npm run lint
```

Те же три шага выполняет CI на каждый push и pull request.

## Коммиты и релизы

Проект использует [Conventional Commits](https://www.conventionalcommits.org/) и semantic-release:
версия и `CHANGELOG.md` формируются из сообщений коммитов, вручную их править не нужно.

```
feat(policy): добавить поддержку YAML
fix(agent): считать память по MemAvailable
docs(readme): описать выбор источника метрик
```

`feat` поднимает minor, `fix` и `perf` — patch, остальные типы релиз не выпускают.
Формат проверяется локально git-хуком и в CI. Полная конвенция — в [CLAUDE.md](CLAUDE.md), п. 1.5.

После `npm install` активируется husky-хук, который проверит сообщение при `git commit`.
