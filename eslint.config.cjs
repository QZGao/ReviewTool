const tseslint = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

const vuePlugin = require('eslint-plugin-vue');
const vueParser = require('vue-eslint-parser');

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

	// Base Vue recommended
	...vuePlugin.configs['flat/recommended'],
	{
		rules: {
			'vue/attributes-order': 'off',
			'vue/component-definition-name-casing': 'off',
			'vue/first-attribute-linebreak': 'off',
			'vue/html-closing-bracket-newline': 'off',
			'vue/html-closing-bracket-spacing': 'off',
			'vue/html-end-tags': 'off',
			'vue/html-indent': 'off',
			'vue/html-quotes': 'off',
			'vue/html-self-closing': 'off',
			'vue/max-attributes-per-line': 'off',
			'vue/multi-word-component-names': 'off',
			'vue/multiline-html-element-content-newline': 'off',
			'vue/no-multi-spaces': 'off',
			'vue/script-indent': 'off',
			'vue/singleline-html-element-content-newline': 'off',
		},
	},

	// Vue SFCs (tabs)
	{
		files: ['src/**/*.vue'],
		languageOptions: {
			parser: vueParser,
			parserOptions: {
				parser: tsParser,
				extraFileExtensions: ['.vue'],

				// typed linting
				projectService: true,
				tsconfigRootDir: __dirname,

				ecmaVersion: 2021,
				sourceType: 'module',
			},
		},
		plugins: {
			vue: vuePlugin,
			'@typescript-eslint': tseslint,
		},
		rules: {
			...typeCheckedRules,
			'@typescript-eslint/no-explicit-any': 'warn',

			// Stop ESLint from acting like a formatter
			indent: 'off',
			'no-tabs': 'off',
		},
	},
];
