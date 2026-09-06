import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Three TS projects: service/, webview/ and the root (scripts/ plus the one
// cross-package test); projectService picks the right tsconfig per file.
export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "**/node_modules/", "uploads/"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["webview/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler rules; the app is not compiled and these flag
      // deliberate ref/setState patterns in effects.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    // Build/test configs sit outside every tsconfig; plain rules only.
    files: ["**/*.{js,mjs}", "**/vite.config.ts", "**/vitest.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
