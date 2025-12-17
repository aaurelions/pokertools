// @ts-check
const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");

module.exports = tseslint.config(
  // 1. Global Ignores
  {
    ignores: [
      "**/dist/",
      "**/lib/",
      "**/node_modules/",
      "**/coverage/",
      "**/*.js",
      "**/*.d.ts",
      "**/generated/",
      "packages/api/generated/**",
      "packages/api/prisma.config.ts",
      "packages/api/prisma/**/*.ts",
      "packages/api/vitest.config.ts",
      "packages/api/tests/**",
      "packages/api/src/workers/**",
    ],
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
      // Allow enum comparisons with string literals (const enums compile to strings)
      "@typescript-eslint/no-unsafe-enum-comparison": "off",

      // Prevent relative imports between packages
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/packages/admin/src/**", "**/packages/api/src/**", "**/packages/bench/src/**", "**/packages/engine/src/**", "**/packages/evaluator/src/**", "**/packages/sdk/src/**", "**/packages/types/src/**",
                "../admin/src/**", "../../admin/src/**", "../../../admin/src/**",
                "../api/src/**", "../../api/src/**", "../../../api/src/**",
                "../bench/src/**", "../../bench/src/**", "../../../bench/src/**",
                "../engine/src/**", "../../engine/src/**", "../../../engine/src/**",
                "../evaluator/src/**", "../../evaluator/src/**", "../../../evaluator/src/**",
                "../sdk/src/**", "../../sdk/src/**", "../../../sdk/src/**",
                "../types/src/**", "../../types/src/**", "../../../types/src/**",
              ],
              message: "Do not import using relative paths from other packages. Use the package name instead."
            }
          ]
        }
      ],
    },
  },

  // 4. EXEMPTIONS: Tests, Benchmarks, and Scripts
  // These files are NOT in your main tsconfig.json, so we must disable
  // type-checked rules for them to prevent parsing errors.
  {
    files: ["**/tests/**/*.ts", "**/*.test.ts", "packages/bench/**/*.ts", "packages/api/scripts/**/*.ts", "packages/api/examples/**/*.ts", "*.config.js"],
    // This instructs the parser NOT to look for a tsconfig for these files
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "no-restricted-imports": "off",
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
  },

  // 5. EXEMPTIONS: API Routes and Services (Fastify/Prisma dynamic types)
  // Fastify routes and Prisma transactions use dynamic types that are hard to type strictly
  {
    files: [
      "packages/api/src/routes/**/*.ts",
      "packages/api/src/services/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
    },
  }
);
