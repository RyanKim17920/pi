/**
 * Native extension loader for Node.js v26+.
 * Handles @earendil-works/* aliases and .ts compilation under node_modules.
 */
import { resolve as pathResolve, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

// Loader's own location — used to resolve esbuild and pi packages relatively
const __loaderDir = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// Transpile cache — avoids re-compiling unchanged .ts files
const CACHE_DIR = pathResolve(homedir(), ".pi", "agent", ".cache", "transpile");

function getCacheKey(filePath) {
	const stat = statSync(filePath);
	const hash = createHash("sha256")
		.update(filePath)
		.update(String(stat.mtimeMs))
		.update(String(stat.size))
		.digest("hex")
		.slice(0, 16);
	return hash;
}

function getCached(filePath) {
	try {
		const cachedPath = pathResolve(CACHE_DIR, getCacheKey(filePath) + ".js");
		if (!existsSync(cachedPath)) return null;
		const sourceStat = statSync(filePath);
		const cachedStat = statSync(cachedPath);
		if (cachedStat.mtimeMs >= sourceStat.mtimeMs) {
			return readFileSync(cachedPath, "utf-8");
		}
	} catch {}
	return null;
}

function setCache(filePath, code) {
	try {
		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}
		const cachedPath = pathResolve(CACHE_DIR, getCacheKey(filePath) + ".js");
		writeFileSync(cachedPath, code, "utf-8");
	} catch {}
}

// Lazy esbuild — only loaded when .ts under node_modules are encountered
let _esbuild = null;
async function getEsbuild() {
	if (!_esbuild) {
		try {
			_esbuild = _require("esbuild");
		} catch {
			_esbuild = false;
		}
	}
	return _esbuild;
}

// Resolve paths relative to the loader's location in the monorepo
const MONOREPO_ROOT = pathResolve(__loaderDir, "../../../../..");
const PI_ROOT = pathResolve(MONOREPO_ROOT, "packages/coding-agent");
const NM = pathResolve(MONOREPO_ROOT, "node_modules");

const aliases = {
	"@earendil-works/pi-coding-agent": pathResolve(PI_ROOT, "dist/index.js"),
	"@earendil-works/pi-agent-core": pathResolve(NM, "@earendil-works/pi-agent-core/dist/index.js"),
	"@earendil-works/pi-tui": pathResolve(NM, "@earendil-works/pi-tui/dist/index.js"),
	"@earendil-works/pi-ai": pathResolve(NM, "@earendil-works/pi-ai/dist/index.js"),
	"@earendil-works/pi-ai/oauth": pathResolve(NM, "@earendil-works/pi-ai/dist/oauth.js"),
	"typebox": pathResolve(NM, "typebox/build/index.mjs"),
	"typebox/compile": pathResolve(NM, "typebox/build/compile/index.mjs"),
	"typebox/value": pathResolve(NM, "typebox/build/value/index.mjs"),
	"@sinclair/typebox": pathResolve(NM, "typebox/build/index.mjs"),
	"@sinclair/typebox/compile": pathResolve(NM, "typebox/build/compile/index.mjs"),
	"@sinclair/typebox/value": pathResolve(NM, "typebox/build/value/index.mjs"),
	"jiti": pathResolve(NM, "jiti/lib/jiti.mjs"),
	"jiti/static": pathResolve(NM, "jiti/lib/jiti-static.mjs"),
	"@mariozechner/pi-coding-agent": pathResolve(PI_ROOT, "dist/index.js"),
	"@mariozechner/pi-agent-core": pathResolve(NM, "@earendil-works/pi-agent-core/dist/index.js"),
	"@mariozechner/pi-tui": pathResolve(NM, "@earendil-works/pi-tui/dist/index.js"),
	"@mariozechner/pi-ai": pathResolve(NM, "@earendil-works/pi-ai/dist/index.js"),
	"@mariozechner/pi-ai/oauth": pathResolve(NM, "@earendil-works/pi-ai/dist/oauth.js"),
};

function resolveExportString(entry) {
	if (typeof entry === 'string') return entry;
	if (Array.isArray(entry)) return entry.find(e => typeof e === 'string') || null;
	if (entry && typeof entry.default === 'string') return entry.default;
	return null;
}

const home = process.env.HOME || homedir();
const agentNpm = pathResolve(home, ".pi/agent/npm/node_modules");

function resolvePkgEntry(pkgDir) {
	const pkgJsonPath = pathResolve(pkgDir, "package.json");
	if (existsSync(pkgJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
			const esmEntry = resolveExportString(pkg.exports?.["."]?.import) || resolveExportString(pkg.exports?.["."]?.default) || resolveExportString(pkg.exports?.import);
			if (esmEntry) {
				const esmPath = pathResolve(pkgDir, esmEntry);
				if (existsSync(esmPath)) return esmPath;
			}
			if (pkg.main) {
				const mainPath = pathResolve(pkgDir, pkg.main);
				if (existsSync(mainPath)) return mainPath;
			}
		} catch {}
	}
	for (const entry of ["index.ts", "index.js", "dist/index.js"]) {
		const entryPath = pathResolve(pkgDir, entry);
		if (existsSync(entryPath)) return entryPath;
	}
	return null;
}

export function resolve(specifier, context, nextResolve) {
	// Strip cache-busting query params for path resolution, preserve in URL
	const cacheBustMatch = specifier.match(/^(.+)\?t=(\d+)$/);
	const cleanSpecifier = cacheBustMatch ? cacheBustMatch[1] : specifier;
	const cacheBustSuffix = cacheBustMatch ? '?t=' + cacheBustMatch[2] : '';

	const withCacheBust = (url) => cacheBustSuffix ? url + cacheBustSuffix : url;
	const resolved = (url, extra) => ({ shortCircuit: true, url: withCacheBust(url), ...extra });

	// Exact aliases
	if (aliases[cleanSpecifier]) {
		return resolved("file://" + aliases[cleanSpecifier]);
	}
	// Alias subpaths (e.g. @earendil-works/pi-ai/oauth)
	for (const [key, val] of Object.entries(aliases)) {
		if (cleanSpecifier.startsWith(key + "/")) {
			const subpath = cleanSpecifier.slice(key.length);
			const baseDir = pathResolve(val, "..");
			const resolvedPath = pathResolve(baseDir, "." + subpath);
			if (existsSync(resolvedPath)) {
				return resolved(pathToFileURL(resolvedPath).href);
			}
			for (const ext of ["", ".js", ".mjs", ".ts"]) {
				const withExt = resolvedPath + ext;
				if (existsSync(withExt)) {
					return resolved(pathToFileURL(withExt).href);
				}
			}
		}
	}

	// Relative specifiers (./ or ../) from extensions
	if (cleanSpecifier.startsWith(".")) {
		const parentURL = context.parentURL;
		if (parentURL) {
			const baseDir = pathResolve(fileURLToPath(parentURL), "..");
			const raw = pathResolve(baseDir, cleanSpecifier);
			if (raw.endsWith(".json") && existsSync(raw)) {
				return resolved(pathToFileURL(raw).href, { importAttributes: { type: "json" } });
			}
			if (existsSync(raw)) {
				if (extname(raw)) {
					return resolved(pathToFileURL(raw).href);
				}
				for (const entry of ["index.ts", "index.js"]) {
					const entryPath = pathResolve(raw, entry);
					if (existsSync(entryPath)) {
						return resolved(pathToFileURL(entryPath).href);
					}
				}
			}
			// .js → .ts/.mts fallback for extensions using TS extensionless imports
			if (!existsSync(raw) && raw.endsWith(".js")) {
				const tsRaw = raw.slice(0, -3) + ".ts";
				if (existsSync(tsRaw)) {
					return resolved(pathToFileURL(tsRaw).href);
				}
				const mtsRaw = raw.slice(0, -3) + ".mts";
				if (existsSync(mtsRaw)) {
					return resolved(pathToFileURL(mtsRaw).href);
				}
			}
			for (const ext of [".ts", ".js", ".mjs", ".mts"]) {
				const withExt = raw + ext;
				if (existsSync(withExt)) {
					return resolved(pathToFileURL(withExt).href);
				}
			}
		}
	}

	// Bare specifiers (non-relative packages)
	if (!cleanSpecifier.startsWith(".") && !cleanSpecifier.startsWith("node:")) {
		const pkgPath = pathResolve(agentNpm, cleanSpecifier);
		if (existsSync(pkgPath)) {
			const entry = resolvePkgEntry(pkgPath);
			if (entry) {
				return resolved(pathToFileURL(entry).href);
			}
		}
		const nmPath = pathResolve(NM, cleanSpecifier);
		if (existsSync(nmPath)) {
			const entry = resolvePkgEntry(nmPath);
			if (entry) {
				return resolved(pathToFileURL(entry).href);
			}
		}
		// Walk up from parent URL to find nested node_modules
		if (context.parentURL) {
			let dir = pathResolve(fileURLToPath(context.parentURL), "..");
			while (dir !== pathResolve(dir, "..")) {
				const nmDir = pathResolve(dir, "node_modules", cleanSpecifier);
				if (existsSync(nmDir)) {
					try {
						const pkg = JSON.parse(readFileSync(pathResolve(nmDir, "package.json"), "utf8"));
						// Prefer ESM entry over CJS main for type:module packages
						const esmEntry = resolveExportString(pkg.exports?.import) || resolveExportString(pkg.exports?.["."]?.default);
						if (esmEntry) {
							const esmPath = pathResolve(nmDir, esmEntry);
							if (existsSync(esmPath) && (pkg.type === "module" || !esmPath.endsWith(".cjs"))) {
								return resolved(pathToFileURL(esmPath).href);
							}
						}
						if (pkg.main) {
							const mainPath = pathResolve(nmDir, pkg.main);
							if (existsSync(mainPath)) {
								return resolved(pathToFileURL(mainPath).href);
							}
						}
					} catch {}
					for (const entry of ["index.ts", "index.js", "dist/index.js"]) {
						const entryPath = pathResolve(nmDir, entry);
						if (existsSync(entryPath)) {
							return resolved(pathToFileURL(entryPath).href);
						}
					}
					try {
						const pkg = JSON.parse(readFileSync(pathResolve(nmDir, "package.json"), "utf8"));
						const esmEntry = resolveExportString(pkg.exports?.import) || resolveExportString(pkg.exports?.["."]?.default);
						if (esmEntry) {
							const esmPath = pathResolve(nmDir, esmEntry);
							if (existsSync(esmPath)) {
								return resolved(pathToFileURL(esmPath).href);
							}
						}
						if (pkg.main) {
							const mainPath = pathResolve(nmDir, pkg.main);
							if (existsSync(mainPath)) {
								return resolved(pathToFileURL(mainPath).href);
							}
						}
						// CJS interop: wrap in synthetic ESM facade via createRequire
						if (pkg.type !== "module") {
							const cjsEntry = pkg.main || "index.js";
							const cjsPath = pathResolve(nmDir, cjsEntry);
							if (existsSync(cjsPath)) {
								const namedExports = [];
								try {
									const cjsMod = _require(cjsPath);
									for (const k of Object.keys(cjsMod)) {
										if (k === "default") continue;
										const safeId = /^[a-zA-Z_$][\w$]*$/.test(k);
										if (safeId) {
											namedExports.push(
												`const _${k} = _cjsMod[${JSON.stringify(k)}];`,
												`export { _${k} as ${k} };`,
											);
										}
									}
								} catch {
									namedExports.push(
										`const _Marked = _cjsMod.Marked;`,
										`export { _Marked as Marked };`,
										`const _default = _cjsMod.default || _cjsMod;`,
										`export default _default;`,
									);
								}
								if (namedExports.length === 0) {
									namedExports.push(
										`const _default = _cjsMod.default || _cjsMod;`,
										`export default _default;`,
									);
								}
								const cjsBaseUrl = pathToFileURL(nmDir + "/").href;
								const wrapperCode = [
									`import { createRequire } from "node:module";`,
									`const _cjsRequire = createRequire(${JSON.stringify(cjsBaseUrl)});`,
									`const _cjsMod = _cjsRequire(${JSON.stringify(cleanSpecifier)});`,
									...namedExports,
								].join("\n");
								return {
									shortCircuit: true,
									url: "data:text/javascript," + encodeURIComponent(wrapperCode),
								};
							}
						}
					} catch {}
				}
				const parent = pathResolve(dir, "..");
				if (parent === dir) break;
				dir = parent;
			}
		}
	}

	// CJS fallback: try harder to find ESM entries before falling through
	if (!cleanSpecifier.startsWith(".") && !cleanSpecifier.startsWith("node:") && !aliases[cleanSpecifier]) {
		for (const searchDir of [pathResolve(agentNpm, cleanSpecifier), pathResolve(NM, cleanSpecifier)]) {
			if (existsSync(searchDir)) {
				const entry = resolvePkgEntry(searchDir);
				if (entry) return resolved(pathToFileURL(entry).href);
			}
		}
		if (context.parentURL) {
			let dir = pathResolve(fileURLToPath(context.parentURL), "..");
			while (dir !== pathResolve(dir, "..")) {
				const nmDir = pathResolve(dir, "node_modules", cleanSpecifier);
				if (existsSync(nmDir)) {
					const entry = resolvePkgEntry(nmDir);
					if (entry) return resolved(pathToFileURL(entry).href);
					const mjsPath = pathResolve(nmDir, "index.mjs");
					if (existsSync(mjsPath)) return resolved(pathToFileURL(mjsPath).href);
					break;
				}
				const parent = pathResolve(dir, "..");
				if (parent === dir) break;
				dir = parent;
			}
		}
	}

	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	const cleanUrl = url.split('?')[0];

	// Compile .ts/.mts under node_modules via esbuild (with cache)
	if ((cleanUrl.endsWith(".ts") || cleanUrl.endsWith(".mts")) && cleanUrl.includes("node_modules")) {
		const filePath = fileURLToPath(cleanUrl);
		const cached = getCached(filePath);
		if (cached) {
			return { shortCircuit: true, format: "module", source: cached };
		}
		const source = readFileSync(filePath, "utf-8");
		const esbuild = await getEsbuild();
		if (!esbuild) {
			return nextLoad(cleanUrl, context);
		}
		const result = esbuild.transformSync(source, {
			loader: "ts",
			format: "esm",
			target: "node20",
			sourcemap: false,
		});
		setCache(filePath, result.code);
		return { shortCircuit: true, format: "module", source: result.code };
	}
	// Let Node.js's default loader handle .js/.mjs in node_modules
	// so CJS interop works correctly via package.json "type" field
	if (cleanUrl.startsWith("file://") && (cleanUrl.endsWith(".js") || cleanUrl.endsWith(".mjs")) && cleanUrl.includes("node_modules")) {
		return nextLoad(cleanUrl, context);
	}
	return nextLoad(cleanUrl, context);
}
