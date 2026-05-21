import js from "@eslint/js"
import {jsdoc} from 'eslint-plugin-jsdoc'
import globals from "globals"
import { defineConfig } from "eslint/config"

/**
 * Extracts the brace-balanced type expressions that follow JSDoc tags in a comment body.
 * @param {string} commentValue The raw comment text between the comment delimiters.
 * @returns {string[]} Each `{...}` type expression, without its surrounding braces.
 */
function jsdocTypeExpressions(commentValue) {
  const types = []
  const tagWithType = /@\w+\s*\{/g
  let match

  while ((match = tagWithType.exec(commentValue))) {
    let depth = 0
    let start = -1

    for (let index = match.index + match[0].length - 1; index < commentValue.length; index++) {
      const character = commentValue[index]

      if (character === "{") {
        if (depth === 0) start = index
        depth++
      } else if (character === "}") {
        depth--

        if (depth === 0) {
          types.push(commentValue.slice(start + 1, index))
          break
        }
      }
    }
  }

  return types
}

// eslint-plugin-jsdoc rejects `any` everywhere (jsdoc/reject-any-type) but only catches `unknown`
// at the top level, so this local rule rejects `unknown` anywhere inside a JSDoc type expression.
const localPlugin = {
  rules: {
    "no-unknown-jsdoc-type": {
      meta: {
        type: "problem",
        docs: {description: "Disallow the `unknown` type anywhere in JSDoc type annotations."},
        messages: {noUnknown: "Avoid the unknown type in JSDoc; use a specific type such as JsonValue (src/json.d.ts) instead."},
        schema: []
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type !== "Block" || !comment.value.startsWith("*")) continue

              const hasUnknown = jsdocTypeExpressions(comment.value).some((type) => /\bunknown\b/.test(type))

              if (hasUnknown) context.report({loc: comment.loc, messageId: "noUnknown"})
            }
          }
        }
      }
    }
  }
}

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
      "jsdoc/reject-any-type": "error"
    }
  }),
  {
    name: "local jsdoc type rules",
    files: ["**/*.{js,mjs,cjs}", "**/bin/rollbridge"],
    plugins: {local: localPlugin},
    rules: {
      "local/no-unknown-jsdoc-type": "error"
    }
  }
])
