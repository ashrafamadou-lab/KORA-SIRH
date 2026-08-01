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
    '/workflow/definitions': {
      post: {
        summary: 'Créer une définition de workflow (draft) — permission workflow.manage',
        security: bearer,
        responses: { '201': { description: 'Créée en draft (version auto-incrémentée)' }, '400': err('Définition invalide'), '403': err('Permission absente') },
      },
    },
    '/workflow/definitions/{id}/activate': {
      post: {
        summary: 'Activer une définition draft (supersède l’active précédente) — workflow.manage',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Activée' }, '400': err('Non draft'), '404': err('Introuvable') },
      },
    },
    '/workflow/instances': {
      post: {
        summary: 'Soumettre une demande dans un workflow — permission workflow.submit',
        security: bearer,
        responses: { '201': { description: 'Instance créée, statut pending' }, '400': err('Aucune étape applicable'), '404': err('Aucune définition active') },
      },
    },
    '/workflow/instances/{id}': {
      get: {
        summary: 'Consulter une instance et son historique append-only — workflow.view',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Instance + history[]' }, '404': err('Introuvable') },
      },
    },
    '/workflow/instances/{id}/approve': {
      post: {
        summary: 'Approuver l’étape courante — workflow.act (acteur assigné, anti-auto-approbation)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Avance ou clôt le workflow' },
          '403': err('Acteur non assigné ou séparation des tâches'),
          '404': err('Introuvable'),
          '409': err('Instance déjà avancée (concurrence — code=stale)'),
        },
      },
    },
    '/workflow/instances/{id}/reject': {
      post: { summary: 'Rejeter — workflow.act', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Rejetée' }, '403': err('Non autorisé'), '409': err('Déjà avancée') } },
    },
    '/workflow/instances/{id}/return': {
      post: { summary: 'Retourner au demandeur — workflow.act', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Retournée' }, '403': err('Non autorisé') } },
    },
    '/workflow/instances/{id}/cancel': {
      post: { summary: 'Annuler (demandeur ou acteur assigné) — workflow.act', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Annulée' }, '403': err('Non autorisé') } },
    },
    '/workflow/instances/{id}/delegate': {
      post: { summary: 'Déléguer l’étape courante à un utilisateur — workflow.act', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Déléguée' }, '403': err('Non assigné') } },
    },
    '/workflow/tick': {
      post: { summary: 'Balayer les échéances (relances + escalades) — workflow.manage', security: bearer, responses: { '200': { description: '{ reminded, escalated }' } } },
    },
    '/config/parameters': {
      post: {
        summary: 'Créer une version draft de paramètre — permission parameters.create ou legal_parameters.create',
        security: bearer,
        responses: { '201': { description: 'Draft créé' }, '400': err('Clé/date invalide ou source manquante (juridique)'), '403': err('Permission absente') },
      },
    },
    '/config/parameters/{id}/submit': {
      post: {
        summary: 'Soumettre au contreseing via le Workflow Engine (definitionKey requis)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ instanceId } — instance de workflow créée' }, '403': err('Permission absente'), '404': err('Introuvable'), '409': err('Non draft, ou aucun workflow de contreseing actif') },
      },
    },
    '/config/parameters/{id}/activate': {
      post: {
        summary: 'Activer un paramètre approuvé (immédiat ou planifié selon la date d’effet)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: '{ status: active | scheduled }' },
          '403': err('Permission absente, ou créateur = activateur (séparation des tâches, juridique)'),
          '404': err('Introuvable'),
          '409': err('Non approuvé, contreseing manquant, ou chevauchement de périodes (code=overlap)'),
        },
      },
    },
    '/config/parameters/{id}/reset-draft': {
      post: {
        summary: 'Repartir d’un draft après un rejet (resoumission)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ status: draft }' }, '409': err('N’est pas rejeté') },
      },
    },
    '/config/parameters/tick': {
      post: { summary: 'Promouvoir les versions planifiées dont la date d’effet est atteinte — parameters.activate', security: bearer, responses: { '200': { description: '{ promoted }' } } },
    },
    '/config/parameters/resolve': {
      get: {
        summary: 'Valeur applicable à une date (query key, date, country) — jamais un draft',
        security: bearer,
        parameters: [
          { name: 'key', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'country', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Valeur résolue (scope tenant ou country)' }, '404': err('Aucune valeur applicable') },
      },
    },
    '/config/parameters/history': {
      get: {
        summary: 'Historique des versions et sources (query key, country)',
        security: bearer,
        parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }, { name: 'country', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'Versions ordonnées par date d’effet' } },
      },
    },
    '/config/parameters/{id}/preview': {
      get: {
        summary: 'Prévisualiser l’impact avant activation (valeur candidate vs actuellement applicable)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'candidateValue + currentlyApplicableAtThatDate' }, '404': err('Introuvable') },
      },
    },
    '/openapi.json': {
      get: { summary: 'Cette spécification', responses: { '200': { description: 'OpenAPI 3.0.3' } } },
    },
  },
} as const;
