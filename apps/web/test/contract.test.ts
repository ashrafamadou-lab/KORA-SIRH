/**
 * Contrat frontend ↔ OpenAPI (E7) : chaque route de la table API_CONTRACT doit
 * exister dans la spécification servie par l'API, avec la même méthode. Les routes
 * de la PWA ne peuvent pas dériver du contrat sans casser la CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_CONTRACT } from '../src/core/api.ts';
import { OPENAPI_SPEC } from '../../api/src/openapi/openapi.spec.ts';

const paths = OPENAPI_SPEC.paths as Record<string, Record<string, unknown>>;

test('chaque entrée du contrat frontend existe dans OpenAPI avec la même méthode', () => {
  for (const [key, def] of Object.entries(API_CONTRACT)) {
    const specEntry = paths[def.path];
    assert.ok(specEntry, `${key} : chemin absent d'OpenAPI → ${def.path}`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(specEntry, def.method),
      `${key} : méthode ${def.method.toUpperCase()} absente pour ${def.path}`,
    );
  }
});

test('les gabarits de chemin utilisent la même convention {param} qu’OpenAPI', () => {
  for (const [key, def] of Object.entries(API_CONTRACT)) {
    assert.ok(!def.path.includes(':'), `${key} : convention :param interdite dans le contrat (${def.path})`);
  }
});

test('la spécification reste en 3.0.3 avec le schéma bearer attendu par le client', () => {
  assert.equal(OPENAPI_SPEC.openapi, '3.0.3');
  const schemes = OPENAPI_SPEC.components.securitySchemes as Record<string, { type: string; scheme: string }>;
  assert.equal(schemes['bearerAuth']!.type, 'http');
  assert.equal(schemes['bearerAuth']!.scheme, 'bearer');
});
