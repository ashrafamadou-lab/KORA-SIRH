/**
 * Build KORA PWA — pur node + tsc, ZÉRO dépendance nouvelle (lockfile intact).
 *
 * Étapes :
 *  1. tsc -p apps/web/tsconfig.json  → dist/app (modules ES natifs, imports .js)
 *  2. copie de public/ (coquille, thème, manifeste)
 *  3. génération des icônes PNG (encodeur maison)
 *  4. assemblage de dist/sw.js : politique + précache RÉEL + worker, en un fichier
 *     classique ; version = empreinte SHA-256 du contenu du shell (détection de
 *     nouvelle version fiable).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawKoraIcon } from './icons.mjs';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(webRoot, 'dist');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`ÉCHEC : ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push('/' + relative(base, full).split('\\').join('/'));
  }
  return out;
}

// 1) compilation stricte
rmSync(dist, { recursive: true, force: true });
run('npx', ['tsc', '-p', join(webRoot, 'tsconfig.json')], webRoot);

// 2) coquille statique
cpSync(join(webRoot, 'public'), dist, { recursive: true });

// 3) icônes
mkdirSync(join(dist, 'icons'), { recursive: true });
writeFileSync(join(dist, 'icons', 'icon-192.png'), drawKoraIcon(192, { pad: 0.04 }));
writeFileSync(join(dist, 'icons', 'icon-512.png'), drawKoraIcon(512, { pad: 0.04 }));
writeFileSync(join(dist, 'icons', 'icon-maskable-192.png'), drawKoraIcon(192, { pad: 0.2, radiusRatio: 0.5 }));
writeFileSync(join(dist, 'icons', 'icon-maskable-512.png'), drawKoraIcon(512, { pad: 0.2, radiusRatio: 0.5 }));

// 4) service worker assemblé (fichier CLASSIQUE unique à la racine du site)
const shellFiles = walk(dist).filter((p) =>
  !p.startsWith('/app/pwa/') && (p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.html')
    || p.endsWith('.webmanifest') || p.endsWith('.png')));
const precache = ['/', '/index.html', ...shellFiles.filter((p) => p !== '/index.html')].sort();

const shellHash = createHash('sha256');
for (const p of [...precache].sort()) {
  if (p === '/') continue;
  shellHash.update(p);
  shellHash.update(readFileSync(join(dist, p.slice(1))));
}
const version = shellHash.digest('hex').slice(0, 12);

const stripModules = (code) => code
  .split('\n')
  .filter((line) => !line.startsWith('import '))
  .map((line) => line.replace(/^export\s+(const|function|class|let|var)/, '$1'))
  .filter((line) => !/^export\s*\{/.test(line))
  .join('\n');

const policy = stripModules(readFileSync(join(dist, 'app', 'pwa', 'sw-policy.js'), 'utf8'));
const worker = stripModules(readFileSync(join(dist, 'app', 'pwa', 'sw.js'), 'utf8'));
const precacheCode = `const SW_VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(precache)};`;
writeFileSync(join(dist, 'sw.js'),
  `/* KORA service worker — généré par build.mjs (shell uniquement, /api jamais en cache) */\n'use strict';\n${policy}\n${precacheCode}\n${worker}\n`);

// le gabarit compilé du précache ne doit pas partir en production
rmSync(join(dist, 'app', 'pwa', 'sw.js'), { force: true });
rmSync(join(dist, 'app', 'pwa', 'sw-precache.js'), { force: true });

console.log(`KORA PWA construit → ${relative(process.cwd(), dist)} (shell v${version}, ${precache.length} entrées précachées)`);
