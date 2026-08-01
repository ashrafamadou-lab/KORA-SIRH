/**
 * Spécification OpenAPI 3.0.3 de l'API KORA — maintenue à la MAIN pour cette tranche
 * (aucune dépendance ajoutée, donc lockfile intact). La génération automatique
 * (@nestjs/swagger) est planifiée avec la prochaine vague de dépendances : ce fichier
 * sera alors remplacé, pas complété. Contrat : tout endpoint vivant figure ici ;
 * l'e2e vérifie la présence des chemins clés.
 */
const bearer = [{ bearerAuth: [] as string[] }];

const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Erreur' } } },
});

export const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'KORA API',
    version: '0.2.0',
    description:
      "SIRH d'entreprise pour le Bénin — API v1. Multi-tenant (RLS PostgreSQL), " +
      'sessions opaques Bearer, MFA TOTP, RBAC par permissions et portées. ' +
      'Spécification maintenue à la main (tranche 2) — génération automatique planifiée.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Jeton de session opaque k1.<tenant>.<aléa> émis par /auth/login',
      },
    },
    schemas: {
      Erreur: {
        type: 'object',
        properties: {
          statusCode: { type: 'integer' },
          message: { type: 'string' },
          code: { type: 'string', description: 'présent pour mfa_required' },
          retryAfterSeconds: { type: 'integer', description: 'présent pour 423 et 429' },
        },
      },
      LoginRequete: {
        type: 'object',
        required: ['tenantSlug', 'email', 'password'],
        properties: {
          tenantSlug: { type: 'string', maxLength: 63 },
          email: { type: 'string', maxLength: 320 },
          password: { type: 'string', maxLength: 512 },
          mfaCode: {
            type: 'string',
            maxLength: 16,
            description: 'TOTP 6 chiffres ou code de récupération XXXX-XXXX (si MFA activé)',
          },
        },
      },
      LoginReponse: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
          user: {
            type: 'object',
            properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string' } },
          },
        },
      },
      Contexte: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          sessionId: { type: 'string', format: 'uuid' },
          email: { type: 'string' },
        },
      },
      CodesRecuperation: {
        type: 'object',
        properties: {
          recoveryCodes: {
            type: 'array',
            items: { type: 'string' },
            description: '8 codes à usage unique — affichés une seule fois',
          },
        },
      },
      Salaries: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                matricule: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
          count: { type: 'integer' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'État de l’API et de la base',
        responses: { '200': { description: 'ok ou degraded' } },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Connexion (mot de passe + MFA le cas échéant)',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/LoginRequete' } },
          },
        },
        responses: {
          '200': {
            description: 'Session créée',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/LoginReponse' } },
            },
          },
          '400': err('Corps invalide'),
          '401': err('Identifiants invalides, ou code=mfa_required'),
          '423': err('Compte temporairement verrouillé (verrouillage progressif)'),
          '429': err('Trop de tentatives (fenêtre glissante par identité et par IP)'),
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Révocation de la session courante (idempotent)',
        security: bearer,
        responses: { '204': { description: 'Révoquée' }, '401': err('Session invalide') },
      },
    },
    '/auth/me': {
      get: {
        summary: 'Contexte de la session courante',
        security: bearer,
        responses: {
          '200': {
            description: 'Contexte',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Contexte' } },
            },
          },
          '401': err('Session invalide, expirée, inactive ou compte désactivé'),
        },
      },
    },
    '/auth/mfa/enroll': {
      post: {
        summary: 'Enrôlement MFA : génère le secret TOTP (scellé côté serveur)',
        security: bearer,
        responses: {
          '200': { description: 'secret + otpauthUri (à présenter en QR)' },
          '401': err('Session invalide'),
          '409': err('MFA déjà activé'),
        },
      },
    },
    '/auth/mfa/activate': {
      post: {
        summary: 'Activation : preuve de possession (code TOTP) → codes de récupération',
        security: bearer,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code'],
                properties: { code: { type: 'string', maxLength: 16 } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'MFA activé',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CodesRecuperation' } },
            },
          },
          '401': err('Code invalide'),
          '409': err('Aucun enrôlement en attente'),
        },
      },
    },
    '/auth/mfa/recovery-codes': {
      post: {
        summary: 'Rotation des codes de récupération (TOTP exigé)',
        security: bearer,
        responses: {
          '200': { description: 'Nouveaux codes (les anciens sont invalidés)' },
          '401': err('Code invalide'),
          '409': err('MFA non activé'),
        },
      },
    },
    '/auth/mfa/disable': {
      post: {
        summary: 'Désactivation du MFA (TOTP ou code de récupération exigé)',
        security: bearer,
        responses: {
          '200': { description: 'MFA désactivé, secret et codes purgés' },
          '401': err('Code invalide'),
          '409': err('MFA non activé'),
        },
      },
    },
    '/auth/sessions': {
      get: {
        summary: 'Mes sessions actives (métadonnées seulement — jamais de jeton)',
        security: bearer,
        responses: { '200': { description: 'Liste des sessions actives' }, '401': err('Session invalide') },
      },
    },
    '/auth/sessions/{id}': {
      delete: {
        summary: 'Révoquer une de mes sessions',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '204': { description: 'Révoquée' },
          '400': err('Identifiant invalide'),
          '404': err('Session introuvable (ou n’appartenant pas à l’utilisateur)'),
        },
      },
    },
    '/auth/sessions/revoke-others': {
      post: {
        summary: 'Révoquer toutes mes autres sessions (garde la courante)',
        security: bearer,
        responses: { '200': { description: '{ revoked: n }' }, '401': err('Session invalide') },
      },
    },
    '/auth/password': {
      post: {
        summary: 'Changer mon mot de passe (ancien vérifié, autres sessions révoquées)',
        security: bearer,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                  currentPassword: { type: 'string', maxLength: 512 },
                  newPassword: { type: 'string', maxLength: 512 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Changé, autres sessions révoquées' },
          '400': err('Politique non respectée (issues[]) ou mot de passe compromis (code=breached)'),
          '401': err('Mot de passe actuel incorrect'),
          '503': err('Vérification de compromission indisponible (mode fail-closed)'),
        },
      },
    },
    '/employees': {
      get: {
        summary: 'Liste des salariés (permission employees.view, bornée RLS au tenant)',
        security: bearer,
        responses: {
          '200': {
            description: 'Liste (limite 100 — pagination par curseur à la tranche Core HR)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Salaries' } },
            },
          },
          '401': err('Session invalide'),
          '403': err('Permission absente ou portée non couvrante (anti-élévation)'),
        },
      },
    },
    '/admin/users': {
      get: {
        summary: 'Lister les comptes (permission users.view)',
        security: bearer,
        responses: { '200': { description: 'Comptes du tenant' }, '403': err('Permission absente') },
      },
      post: {
        summary: 'Créer un compte (permission users.create ; politique + compromission)',
        security: bearer,
        responses: {
          '201': { description: 'Créé' },
          '400': err('Email/mot de passe invalide, ou compromis'),
          '403': err('Permission absente'),
          '409': err('Email déjà utilisé'),
          '503': err('Compromission indisponible (fail-closed)'),
        },
      },
    },
    '/admin/users/{id}/activate': {
      post: {
        summary: 'Activer un compte (permission users.edit)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Activé' }, '403': err('Permission absente'), '404': err('Introuvable') },
      },
    },
    '/admin/users/{id}/deactivate': {
      post: {
        summary: 'Désactiver un compte — révoque toutes ses sessions (permission users.edit)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ sessionsRevoked: n }' }, '403': err('Permission absente') },
      },
    },
    '/admin/users/{id}/roles': {
      post: {
        summary: 'Affecter des rôles — borné aux permissions de l’acteur (permission users.manage_roles)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Affectés' },
          '400': err('Rôles inconnus'),
          '403': err('Permission absente, ou délégation refusée (escalade — permissions[])'),
        },
      },
    },
    '/admin/users/{id}/revoke-sessions': {
      post: {
        summary: 'Révoquer administrativement toutes les sessions d’un compte (permission sessions.revoke)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ revoked: n }' }, '403': err('Permission absente') },
      },
    },
    '/openapi.json': {
      get: { summary: 'Cette spécification', responses: { '200': { description: 'OpenAPI 3.0.3' } } },
    },
  },
} as const;
