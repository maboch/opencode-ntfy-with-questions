import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "bun.lock", "*.json", "notification-ntfy-with-questions.schema.json"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The OpenCode plugin hook surface is typed with `any` (args/options),
      // so a blanket ban would force pointless casts.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
)
