# [1.0.0](https://github.com/dato-dev/pve-vm-autoscaler/compare/v0.1.2...v1.0.0) (2026-07-26)


### Documentation

* перейти на работу в ветках вместо коммитов в main ([ae153af](https://github.com/dato-dev/pve-vm-autoscaler/commit/ae153af4c760a4ad7729f278121da68d3e9efd80))


### BREAKING CHANGES

* ставится в ломающий коммит, а не в последний в ветке.

Отдельно зафиксировано, что статус GitHub Actions после пуша не
проверяется. Если в окружении при этом нет npm, изменение уходит в main
непроверенным — это нужно называть прямо в отчёте.

## [0.1.2](https://github.com/dato-dev/pve-vm-autoscaler/compare/v0.1.1...v0.1.2) (2026-07-26)


### Bug Fixes

* **db:** считать только живые ноды и фильтровать их в SQL ([5dd861c](https://github.com/dato-dev/pve-vm-autoscaler/commit/5dd861caf15498bee52a4683761edcd8ea1db4d2))

## [0.1.1](https://github.com/dato-dev/pve-vm-autoscaler/compare/v0.1.0...v0.1.1) (2026-07-26)


### Bug Fixes

* **db:** выполнять saveMetric на одном соединении пула ([afc589a](https://github.com/dato-dev/pve-vm-autoscaler/commit/afc589aca75920792963d799ef06fc310b419692))
