import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The audio Engine is a long-lived mutable object kept in a ref and read during
      // render by design (it lives outside React; see audioEngine.js). These React
      // Compiler rules assume immutable props/refs, which this app doesn't use.
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
    },
  },
])
