import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    ignores: [
      "dist/",
      "**/*.test.ts",
      "scripts/",
      "test-types/",
      // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.4 — Windows
      // AppContainer addon. C++ sources (`src/*.cc`) and the JS loader
      // (`loader.js`) live outside the TypeScript project graph; the
      // typescript-eslint project service would error on them.
      "native/",
    ],
  },
);
