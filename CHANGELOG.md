# [2.0.0](https://github.com/dato-dev/pve-vm-autoscaler/compare/v1.0.3...v2.0.0) (2026-07-26)


* feat(policy)!: перевести конфигурацию на YAML с шаблонами машин ([bc2dca5](https://github.com/dato-dev/pve-vm-autoscaler/commit/bc2dca584a8ae1799ec8bda69f48598c22317013))


### Features

* **shared:** добавить парсеры duration, quantity и percent ([7c2ae3a](https://github.com/dato-dev/pve-vm-autoscaler/commit/7c2ae3a7e3ee9485746e06751beb373a78fe9809))
* **shared:** добавить схему политики с шаблонами машин ([5095040](https://github.com/dato-dev/pve-vm-autoscaler/commit/5095040202ce49c0f923fe94c51d951a71d34162))


### BREAKING CHANGES

* infra/policy.example.json заменён на policy.example.yaml
со сменой структуры. nodeTemplates отделены от policies и связаны по
имени; targetNode стал hypervisor, minNodes и maxNodes — nodes.min и
nodes.max, selector.labels — плоским selector, thresholds — секцией
scaleUp. Длительности записываются строками (5m, 1h30m), объёмы —
2Gi и 20Gi, пороги — 60% со знаком процента. Поле version: 1
обязательно. Конвертация: npm run policy:convert -- old.json > policy.yaml

## [1.0.3](https://github.com/dato-dev/pve-vm-autoscaler/compare/v1.0.2...v1.0.3) (2026-07-26)


### Bug Fixes

* **db:** усреднять нагрузку по нодам, а не по строкам метрик ([ecafc7c](https://github.com/dato-dev/pve-vm-autoscaler/commit/ecafc7cdbcee393b04bd5234c20c147e9a065762))

## [1.0.2](https://github.com/dato-dev/pve-vm-autoscaler/compare/v1.0.1...v1.0.2) (2026-07-26)


### Bug Fixes

* **agent:** считать память по MemAvailable вместо MemFree ([462a0ac](https://github.com/dato-dev/pve-vm-autoscaler/commit/462a0acf6164296b8e46e7dcb9bf97bc57fba209))

## [1.0.1](https://github.com/dato-dev/pve-vm-autoscaler/compare/v1.0.0...v1.0.1) (2026-07-26)


### Bug Fixes

* **metrics:** отвечать 400 на невалидный payload вместо 500 ([eb4f0a7](https://github.com/dato-dev/pve-vm-autoscaler/commit/eb4f0a79eac465d2c927e4e832f7fb61d6f8add9))
* **server:** обрывать запрос на 401 и сравнивать токен за постоянное время ([7545ee2](https://github.com/dato-dev/pve-vm-autoscaler/commit/7545ee2f5077e307a749d479932e793bdfb34ce4))

# [1.0.0](https://github.com/dato-dev/pve-vm-autoscaler/compare/v0.1.2...v1.0.0) (2026-07-26)


### Documentation

* перейти на работу в ветках вместо коммитов в main ([ae153af](https://github.com/dato-dev/pve-vm-autoscaler/commit/ae153af4c760a4ad7729f278121da68d3e9efd80))


### Примечание к версии

Мажорная версия выпущена по ошибке. Ломающих изменений в этом релизе нет: в теле
`docs`-коммита фраза `BREAKING CHANGE` из описания правила попала в начало строки,
и парсер conventional-changelog принял её за футер. Опубликованную историю решено
не переписывать. Функционально проект остаётся MVP — состав возможностей и открытые
ограничения перечислены в [ROADMAP.md](ROADMAP.md).

## [0.1.2](https://github.com/dato-dev/pve-vm-autoscaler/compare/v0.1.1...v0.1.2) (2026-07-26)


### Bug Fixes

* **db:** считать только живые ноды и фильтровать их в SQL ([5dd861c](https://github.com/dato-dev/pve-vm-autoscaler/commit/5dd861caf15498bee52a4683761edcd8ea1db4d2))

## [0.1.1](https://github.com/dato-dev/pve-vm-autoscaler/compare/v0.1.0...v0.1.1) (2026-07-26)


### Bug Fixes

* **db:** выполнять saveMetric на одном соединении пула ([afc589a](https://github.com/dato-dev/pve-vm-autoscaler/commit/afc589aca75920792963d799ef06fc310b419692))
