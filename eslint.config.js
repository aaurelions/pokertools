// @ts-check
const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");

module.exports = tseslint.config(
  // 1. Global Ignores
  {
    ignores: ["**/dist/", "**/lib/", "**/node_modules/", "**/coverage/", "**/*.js", "**/*.d.ts"],
  },

  // 2. Base Configurations (Strict)
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // 3. Core Project Configuration (Applies to everything by default)
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // --- Strict Code Quality ---

      // Enforce cleanup of unused variables (allow _ prefix for intentionally unused)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Enforce nullish coalescing (??) over logical OR (||)
      "@typescript-eslint/prefer-nullish-coalescing": "error",

      // Enforce standard array types (T[] instead of Array<T>)
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],

      // Force correct usage of Promises
      "@typescript-eslint/no-floating-promises": "error",

      // Safety: Disallow `any` (Warns you to fix types)
      "@typescript-eslint/no-explicit-any": "warn",

      // --- Pragmatic Overrides for Redux/Engine Patterns ---
      // Allow case declarations (needed for gameReducer)
      "no-case-declarations": "off",
      // Allow re-throwing errors (needed for PokerEngine)
      "no-useless-catch": "off",
      // Allow require() in specific legacy spots (downgraded to warning)
      "@typescript-eslint/no-require-imports": "warn",
    },
  },

  // 4. EXEMPTIONS: Tests and Benchmarks
  // These files are NOT in your main tsconfig.json, so we must disable
  // type-checked rules for them to prevent parsing errors.
  {
    files: ["**/tests/**/*.ts", "**/*.test.ts", "packages/bench/**/*.ts", "*.config.js"],
    // This instructs the parser NOT to look for a tsconfig for these files
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // Turn off rules that require type information
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/await-thenable": "off",

      // Tests often use any/non-null assertions
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
    },
  }
);
