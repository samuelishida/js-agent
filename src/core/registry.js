// src/core/registry.js
// Lightweight module registry for dependency injection.
// Zero-build, zero-runtime-impact validation layer over window.* globals.

/** @type {Object.<string, Object>} */
const _modules = {};

/**
 * Register a module in the registry.
 * @param {string} name - Module identifier
 * @param {Object} api - Module API object
 */
function register(name, api) {
  if (_modules[name] && _modules[name] !== api) {
    console.warn(`[registry] Overwriting module: ${name}`);
  }
  _modules[name] = Object.freeze(api);
}

/**
 * Resolve a module from the registry.
 * @param {string} name - Module identifier
 * @returns {Object} The registered module API
 * @throws {Error} If module is not found
 */
function resolve(name) {
  if (!_modules[name]) {
    throw new Error(
      `[registry] Module not found: ${name}. ` +
      `Available: ${Object.keys(_modules).join(', ')}`
    );
  }
  return _modules[name];
}

/**
 * List all registered module names.
 * @returns {string[]}
 */
function listModules() {
  return Object.keys(_modules);
}

window.AgentRegistry = { register, resolve, listModules };
