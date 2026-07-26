/**
 * Конфигурация commitlint. Держится в синхроне с CLAUDE.md, п. 1.5 —
 * если правишь список типов или компонентов, правь оба места.
 *
 * Типы напрямую влияют на версию через semantic-release:
 * feat → minor, fix/perf → patch, остальные релиза не выпускают,
 * а `!` или футер BREAKING CHANGE поднимает мажор (до 1.0.0 — минор).
 */
export default {
  extends: ["@commitlint/config-conventional"],

  /**
   * Коммиты, которые semantic-release создаёт сам, проверять человеческими
   * правилами незачем: в их теле лежат сгенерированные release notes —
   * markdown-ссылки на коммиты, заведомо длиннее лимита строки.
   */
  ignores: [(message) => /^chore\(release\):/.test(message)],

  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "perf", "refactor", "test", "docs", "ci", "build", "chore", "revert"]
    ],

    // Компонент необязателен, но если указан — только из этого списка.
    // Пустой элемент "" разрешает коммиты без scope (например, `docs: ...`).
    "scope-enum": [
      2,
      "always",
      [
        "",
        "agent",
        "agent-go",
        "server",
        "evaluator",
        "metrics",
        "db",
        "policy",
        "proxmox",
        "shared",
        "infra",
        "scripts",
        "release",
        "deps",
        "roadmap",
        "readme"
      ]
    ],

    // Заголовки на русском: правило про регистр из config-conventional
    // рассчитано на латиницу и на кириллице даёт ложные срабатывания.
    "subject-case": [0],

    "header-max-length": [2, "always", 100]
  }
};
