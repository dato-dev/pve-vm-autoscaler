#!/usr/bin/env bash
# Установка зависимостей в CI.
#
# npm ci воспроизводим и быстрее, но требует package-lock.json. Пока лока в
# репозитории нет (M1.10a), откатываемся на npm install и подсвечиваем это
# предупреждением в интерфейсе Actions. Как только лок будет закоммичен,
# скрипт сам переключится на npm ci — отдельная правка workflow не нужна.
set -euo pipefail

if [ -f package-lock.json ]; then
  echo "package-lock.json найден — воспроизводимая установка"
  npm ci
else
  echo "::warning title=Нет package-lock.json::Сборка невоспроизводима: версии \
резолвятся заново на каждом прогоне. Сгенерируйте лок командой npm install и \
закоммитьте его (пункт M1.10a в ROADMAP)."
  npm install
fi
