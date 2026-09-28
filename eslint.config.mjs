// ESLint flat config for the backend (TypeScript).
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
];