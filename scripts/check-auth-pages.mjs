import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function fail(message) {
  throw new Error(message);
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) fail(`${label}: missing ${needle}`);
}

function assertOrder(source, before, after, label) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  if (beforeIndex === -1) fail(`${label}: missing ${before}`);
  if (afterIndex === -1) fail(`${label}: missing ${after}`);
  if (beforeIndex > afterIndex) fail(`${label}: expected ${before} before ${after}`);
}

const login = read('dashboard/login.html');
const register = read('dashboard/register.html');
const headers = read('_headers');

assertIncludes(login, '<script src="https://accounts.google.com/gsi/client" async defer></script>', 'login');
assertIncludes(login, '<script src="gsi-auth.js?v=', 'login');
assertIncludes(login, 'window.gsiAuth.initGoogleSignIn', 'login');
assertIncludes(login, 'id="gsi-button"', 'login');
assertIncludes(login, 'or sign in with email', 'login');
assertIncludes(login, 'href="forgot-password.html"', 'login');
assertIncludes(login, 'Forgot password?', 'login');
assertOrder(login, 'id="gsi-button"', 'or sign in with email', 'login');
assertOrder(login, 'or sign in with email', '<form id="login-form"', 'login');

assertIncludes(register, '<script src="https://accounts.google.com/gsi/client" async defer></script>', 'register');
assertIncludes(register, '<script src="gsi-auth.js?v=', 'register');
assertIncludes(register, 'window.gsiAuth.initGoogleSignIn', 'register');
assertIncludes(register, 'id="gsi-button"', 'register');
assertIncludes(register, 'id="gsi-fallback"', 'register');
assertIncludes(register, 'Continue with Gmail', 'register');
assertIncludes(register, "provider: 'google'", 'register');
assertIncludes(register, 'or register with email', 'register');
assertOrder(register, 'id="gsi-button-wrap"', 'or register with email', 'register');
assertOrder(register, 'or register with email', '<form id="reg-form"', 'register');

assertIncludes(headers, '/dashboard/*.html', '_headers');
assertIncludes(headers, 'Cache-Control: public, max-age=300, must-revalidate', '_headers');

console.log('Auth page regression checks passed.');
