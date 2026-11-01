import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "scripts/**/*.ts"],
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // CLAUDE.md §3.2: rules.ts is 100% pure — imports nothing from db, next/*, or other modules.
    files: ["src/modules/*/rules.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/lib/db*", "drizzle-orm*"], message: "rules.ts must remain pure (no DB imports)." },
            { group: ["next", "next/*"], message: "rules.ts must not import next/*." },
            { group: ["@/modules/*"], message: "rules.ts must not import other domain modules." },
          ],
        },
      ],
    },
  },
  {
    // CLAUDE.md §3.2: UI routes and components call queries.ts and actions.ts only — never db or mutations.ts.
    files: ["src/app/(dashboard)/**/*.{ts,tsx}", "src/modules/*/components/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/lib/db*"], message: "UI/routes must call queries.ts or actions.ts, never @/lib/db directly." },
            {
              group: [
                "@/modules/*/mutations*",
                "@/modules/*/placement*",
                "@/modules/*/fulfillment*",
                "@/modules/*/replenishment*",
              ],
              message: "UI/routes must call actions.ts for writes, never mutations directly.",
            },
          ],
        },
      ],
    },
  },
);
