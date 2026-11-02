/**
 * Minimal Standard Schema config helper.
 *
 * Cordis reads `runtime.Config['~standard'].validate(config)`; a plugin that
 * exports a plain object without `~standard` throws at load time. We cannot
 * import `@deepseek-ai/schemastery` here: this package lives outside the
 * profile's node_modules tree, so bare imports of `@deepseek-ai/*` fail with
 * ERR_MODULE_NOT_FOUND. A hand-rolled Standard Schema keeps the plugin
 * dependency-free.
 */

/**
 * @param {Record<string, unknown>} defaults default value per key
 * @param {(value: Record<string, unknown>) => string[]} [check] returns issue messages
 */
export function config(defaults, check) {
	return {
		'~standard': {
			version: 1,
			vendor: 'dsh-scihub',
			validate(raw) {
				const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
				const value = {};
				for (const [key, fallback] of Object.entries(defaults)) {
					value[key] = input[key] === undefined ? fallback : input[key];
				}
				if (check) {
					const issues = check(value);
					if (issues.length) {
						return { issues: issues.map((message) => ({ message, path: [] })) };
					}
				}
				return { value };
			},
		},
	};
}

/**
 * Fill in the defaults for anything the caller left out. Cordis normally
 * hands over an already-validated object; a hand-written bundle patch may
 * pass raw values, so both paths must work.
 */
export function resolveConfig(raw, defaults) {
	const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	const value = {};
	for (const [key, fallback] of Object.entries(defaults)) {
		value[key] = input[key] === undefined ? fallback : input[key];
	}
	return value;
}
