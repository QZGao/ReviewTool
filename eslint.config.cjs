const tseslint = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

const typeChecked = tseslint.configs['recommended-type-checked'] || {};
const typeCheckedRules = typeChecked.rules || {};

module.exports = [
	{
		ignores: ['dist/**', 'node_modules/**'],
	},

	// TypeScript (tabs)
	{
		files: ['src/**/*.{ts,tsx}'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				// typed linting
				projectService: true,
				tsconfigRootDir: __dirname,

				ecmaVersion: 2021,
				sourceType: 'module',
			},
		},
		plugins: {
			'@typescript-eslint': tseslint,
		},
		rules: {
			...typeCheckedRules,
			'@typescript-eslint/no-explicit-any': 'warn',

			// Respect tabs in .ts/.tsx
			indent: 'off',
			'no-tabs': 'off',
		},
	},
];
