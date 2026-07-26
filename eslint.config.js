import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  // Глобальные игноры. Во flat-config объект, содержащий ТОЛЬКО ignores,
  // задаёт игнор для всего конфига. Если в этом же объекте лежат rules,
  // игнор сужается до него одного — и eslint пойдёт по dist/** после сборки,
  // из-за чего `npm run build && npm run lint` падал бы в CI.
  {
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
];
