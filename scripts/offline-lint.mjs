// Runs Forge's client-side linters without a registered app id: node scripts/offline-lint.mjs "$PWD"
// (Uses the globally installed @forge/cli. Once the app is registered, plain `forge lint` replaces this.)
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path';
const require = createRequire('/home/box/.local/lib/node_modules/@forge/cli/out/bin/cli.js');
const { lint } = require('@forge/lint');
const yaml = require('yaml');
const root = process.argv[2];
process.chdir(root);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk('./src');
const manifest = yaml.parse(fs.readFileSync('manifest.yml', 'utf8'));
const statsig = new Proxy({}, { get: (_, k) => async () => (k === 'getDeprecatedRuntimes' ? [] : true) });
const logger = { info: console.log, warn: console.log, error: console.log, debug: () => {}, trace: () => {} };
const results = await lint(files, manifest, 'development', logger, statsig, { linter: { mode: 'client-side', graphqlClient: undefined } });
let n = 0;
for (const r of results) for (const kind of ['errors', 'warnings']) for (const p of r[kind] || []) { n++; console.log(kind, r.constructor?.name, JSON.stringify(p).slice(0, 400)); }
console.log('problems:', n, 'linters:', results.length);
