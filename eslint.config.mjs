import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// zunia-dashboard and zunia-website get this stack through eslint-config-next. This is
// not a Next app, so the same layers are composed by hand: js + typescript-eslint +
// jsx-a11y + react-hooks.
const eslintConfig = defineConfig([
  globalIgnores([
    // wxt build output and generated types.
    ".output/**",
    ".wxt/**",
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  reactHooks.configs.flat["recommended-latest"],

  {
    // `_`-prefixed names are this codebase's marker for a binding that exists
    // only to be discarded. The `{ rpc: _rpc, ...rest }` omit idiom is the only
    // way to strip keys off an object without hand-writing the remaining field
    // types, and `ignoreRestSiblings` does not cover a *renamed* sibling. Without
    // this the rule cannot tell "deliberately dropped" from "forgot to use", so
    // every omit site would need its own suppression comment. No `files` key:
    // typescript-eslint's recommended config applies this rule to the .mjs build
    // scripts as well.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      // wxt auto-imports `browser`, `defineBackground` and friends; TypeScript resolves
      // them from .wxt/types, and typescript-eslint disables no-undef for .ts anyway.
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      // eslint-config-next enables only a six-rule jsx-a11y subset. This surface signs
      // and sends funds from the keyboard as well as the mouse, so the interaction and
      // labelling rules are errors rather than off.
      "jsx-a11y/label-has-associated-control": "error",
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/no-noninteractive-element-interactions": "error",
    },
  },

  {
    // Build-time scripts run under node, not the extension sandbox.
    files: ["scripts/**/*.mjs", "verify-vec.mjs", "*.config.ts", "*.config.mjs"],
    languageOptions: { globals: globals.node },
  },
]);

export default eslintConfig;
