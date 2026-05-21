import js from "@eslint/js"
import {jsdoc} from 'eslint-plugin-jsdoc'
import globals from "globals"
import { defineConfig } from "eslint/config"

export default defineConfig([
  {
    name: "global ignores",
    ignores: ["build/**", "dist/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs}", "**/bin/rollbridge"],
    plugins: {js},
    extends: ["js/recommended"],
    languageOptions: {
      globals: {...globals.browser, ...globals.node}
    },
    rules: {
      "no-unused-vars": ["error", {argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_"}]
    }
  },
  jsdoc({
    config: "flat/recommended",
    files: ["**/*.{js,mjs,cjs}", "**/bin/rollbridge"],
    rules: {
      "jsdoc/reject-any-type": "off"
    }
  })
])
