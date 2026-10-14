import eslintConfig from '@electron-toolkit/eslint-config'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import typescriptParser from '@typescript-eslint/parser'
import typescriptPlugin from '@typescript-eslint/eslint-plugin'

export default [
  { ignores: ['**/node_modules', '**/dist', '**/out', '.test-artifacts/**'] },
  eslintConfig,
  ...eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.ts'],
    languageOptions: { parser: typescriptParser }
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: typescriptParser } }
  },
  {
    files: ['**/*.ts', '**/*.vue'],
    plugins: { '@typescript-eslint': typescriptPlugin },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
      ]
    }
  },
  {
    files: ['**/*.{js,jsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off'
    }
  },
  eslintConfigPrettier
]
