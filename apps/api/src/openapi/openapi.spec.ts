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
        description:
          'Zone PROFESSIONNELLE uniquement (E9) — jamais d’identifiants complets, de coordonnées personnelles, ' +
          'd’urgence, de documents ni de données médicales dans les listes générales.',
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
                usageFirstName: { type: 'string', nullable: true },
                usageLastName: { type: 'string', nullable: true },
                status: { type: 'string', enum: ['draft', 'pre_hire', 'active', 'suspended', 'on_leave', 'terminated', 'archived'] },
                hireDate: { type: 'string', format: 'date', nullable: true },
                professionalStatus: { type: 'string', nullable: true },
                employerCompanyId: { type: 'string', format: 'uuid', nullable: true },
                mainSiteId: { type: 'string', format: 'uuid', nullable: true },
                workEmail: { type: 'string', nullable: true },
                workPhone: { type: 'string', nullable: true },
                photoRef: { type: 'string', nullable: true },
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
        summary: 'Liste des dossiers salariés — zone PROFESSIONNELLE uniquement, filtrée par la PORTÉE réelle de l’acteur (E9)',
        description:
          'employees.view requis. Portée tenant = tout le tenant ; legal_entity/site/department/team = les salariés ' +
          'dont l’affectation PRINCIPALE applicable tombe dans le périmètre. JAMAIS dans cette liste : identifiants ' +
          'complets (CNSS, fiscal, pièces), coordonnées personnelles, contacts d’urgence, coordonnées bancaires, ' +
          'documents, données médicales. Filtres : query, status, companyId, siteId, unitId, limit (≤200), offset.',
        security: bearer,
        responses: {
          '200': {
            description: 'Zone professionnelle des salariés du périmètre',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Salaries' } },
            },
          },
          '401': err('Session invalide'),
          '403': err('Permission absente ou aucune portée applicable (anti-élévation)'),
        },
      },
      post: {
        summary: 'Créer un dossier salarié (statut initial : draft) — employees.manage, audité',
        description: 'matricule UNIQUE dans le tenant (A-Z, 0-9, . _ -, 30 max) et IMMUABLE ensuite. Les zones personnelle et administrative se renseignent via leurs routes dédiées.',
        security: bearer,
        responses: { '201': { description: '{ id, status: draft }' }, '400': err('Champ invalide ou référence introuvable'), '409': err('Matricule déjà utilisé (code=duplicate_matricule)') },
      },
    },
    '/employees/{id}': {
      get: {
        summary: 'Détail PROFESSIONNEL d’un dossier + affectation principale courante — employees.view (hors périmètre : 404)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Zone professionnelle + currentAssignment' }, '404': err('Introuvable ou hors périmètre (aucune divulgation)') },
      },
      patch: {
        summary: 'Modifier la zone professionnelle (identité d’usage, dates, rattachements de référence) — employees.manage par cible, audité old/new',
        description: 'Le matricule est IMMUABLE (garde SQL) ; le statut se change exclusivement via /employees/{id}/status.',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ updated }' }, '400': err('Champ invalide'), '403': err('Portée non couvrante'), '404': err('Introuvable') },
      },
    },
    '/employees/{id}/private': {
      get: {
        summary: 'Zone PERSONNELLE (naissance, nationalité, sexe déclaratif, coordonnées, adresse, urgence) — employees.view_private, lecture AUDITÉE',
        description: 'Chaque consultation laisse une trace d’audit nominative (employee_private_viewed). Le sexe n’est collecté que pour les déclarations sociales légales (finalité documentée) — jamais décisionnel.',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ private }' }, '403': err('Permission dédiée absente'), '404': err('Introuvable ou hors périmètre') },
      },
      put: {
        summary: 'Renseigner la zone personnelle — employees.manage + employees.view_private, audit à valeurs MASQUÉES',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ updated }' }, '400': err('Champ invalide'), '403': err('Permission ou portée insuffisante'), '404': err('Introuvable') },
      },
    },
    '/employees/{id}/identifiers': {
      get: {
        summary: 'Zone ADMINISTRATIVE (CNSS, IFU, pièce d’identité) — employees.view_identifiers, lecture AUDITÉE',
        description: 'Le format du numéro CNSS est un PARAMÈTRE juridique (CNS-06) — jamais une règle en dur. Chaque consultation laisse une trace (employee_identifiers_viewed).',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ identifiers }' }, '403': err('Permission dédiée absente'), '404': err('Introuvable ou hors périmètre') },
      },
      put: {
        summary: 'Renseigner la zone administrative — employees.manage + employees.view_identifiers, audit à valeurs MASQUÉES (•••+3)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ updated }' }, '400': err('Champ invalide'), '403': err('Permission ou portée insuffisante'), '404': err('Introuvable'), '409': err('CNSS déjà rattaché à un autre dossier — la valeur n’est jamais renvoyée (code=duplicate_cnss)') },
      },
    },
    '/employees/{id}/documents': {
      get: {
        summary: 'MÉTADONNÉES des documents du dossier — employees.view_documents, lecture AUDITÉE',
        description: 'Métadonnées uniquement : type, libellé, sensibilité, dates. Le CONTENU et les références de stockage ne sont JAMAIS exposés — le module documentaire est un incrément ultérieur (NOT IMPLEMENTED).',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ documents[] }' }, '403': err('Permission dédiée absente'), '404': err('Introuvable ou hors périmètre') },
      },
      post: {
        summary: 'Déclarer un document (métadonnées) — employees.manage par cible, audité',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '201': { description: '{ id }' }, '400': err('Type de document inconnu'), '403': err('Portée non couvrante'), '404': err('Introuvable') },
      },
    },
    '/employees/{id}/status': {
      post: {
        summary: 'Transition de cycle de vie (draft→pre_hire→active⇄suspended/on_leave→terminated→archived, RÉINTÉGRATION terminated→active) — employees.manage par cible',
        description:
          'Transitions contrôlées (miroir applicatif + garde SQL), TOUTES auditées avec old/new et tracées en ' +
          'ÉVÉNEMENT DE CARRIÈRE append-only. Une cessation CLÔT les affectations ouvertes à la date d’effet et ne ' +
          'supprime JAMAIS le dossier ni ne réécrit l’historique. Avec workflowDefinitionKey : changement soumis au ' +
          'Workflow Engine (E3), appliqué seulement à l’approbation (conflict si l’état a bougé). Notification ' +
          'hr.change_applied APRÈS application effective (demandeur + salarié lié).',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ status, effectiveDate, careerEvent } ou { submitted, pendingChangeId, workflowInstanceId }' }, '400': err('Transition interdite'), '403': err('Portée non couvrante'), '404': err('Introuvable ou définition de workflow inactive') },
      },
    },
    '/employees/{id}/assignments': {
      get: {
        summary: 'Historique COMPLET des affectations datées — employees.view_history',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ assignments[] } (périodes closes ET ouvertes — rien n’est effacé)' }, '404': err('Introuvable ou hors périmètre') },
      },
      post: {
        summary: 'Créer une affectation DATÉE (société, site?, unité, poste?, emploi?, centre de coûts?, manager dérogatoire?) — employees.assign + portée réelle',
        description:
          'UNE SEULE affectation PRINCIPALE applicable à une date (contrainte d’exclusion PostgreSQL) : la nouvelle ' +
          'principale CLÔT la précédente à la date d’effet — l’histoire reste consultable. Secondaires/intérim avec ' +
          'pourcentage (allocationPct 1..100, assignmentKind standard|interim|temporary). Le poste visé doit être ' +
          'ACTIF et rattaché à l’organisation à la date d’effet (sinon 409 position_not_active). Portée : l’acteur ' +
          'doit couvrir le salarié ET l’unité cible. Toutes les cibles sont des FK COMPOSITES — l’inter-tenant est ' +
          'rejeté par PostgreSQL. Avec workflowDefinitionKey : soumission E3, application à l’approbation.',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '201': { description: '{ id, careerEvent } ou { submitted, … }' }, '400': err('Référence introuvable ou champ invalide'), '403': err('Portée non couvrante (salarié ou cible)'), '404': err('Introuvable'), '409': err('Poste inactif à la date (code=position_not_active)') },
      },
    },
    '/employees/{id}/career': {
      get: {
        summary: 'Historique de carrière APPEND-ONLY (hire, transfer, promotion, suspension, termination, reinstatement…) — employees.view_history',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ events[] } — aucun événement n’est jamais modifié ni supprimé (garde SQL)' }, '404': err('Introuvable ou hors périmètre') },
      },
    },
    '/employees/{id}/at': {
      get: {
        summary: 'État du dossier À UNE DATE : statut (reconstruit de la carrière), affectation principale applicable, responsable résolu — employees.view_history',
        description: 'Une mutation FUTURE ne change JAMAIS la lecture passée : le statut vient des événements de carrière, l’affectation des périodes datées.',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }],
        responses: { '200': { description: '{ date, status, assignment, manager }' }, '404': err('Introuvable ou hors périmètre') },
      },
    },
    '/employees/{id}/manager': {
      get: {
        summary: 'Responsable hiérarchique À UNE DATE — dérogation explicite sinon RÉSOLUTION PAR LA STRUCTURE DES POSTES (E8)',
        description: 'Ordre : manager_override de l’affectation principale, sinon poste → org.position_manager_at(date) → titulaire principal de ce poste à la date.',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }],
        responses: { '200': { description: '{ date, manager } (via=override|position)' }, '404': err('Introuvable ou hors périmètre') },
      },
    },
    '/hr/import': {
      post: {
        summary: 'Import CSV de salariés (preview | apply ATOMIQUE, stratégie EXPLICITE create_only) — employees.import, audité',
        description:
          'Colonnes : matricule, last_name, first_name, hire_date, company_code, site_code, unit_code, position_code, ' +
          'job_code, cost_center_code, effective_from, professional_status, work_email, birth_date, nationality, ' +
          'personal_email, personal_phone, cnss_number, tax_id. Validation COMPLÈTE avant toute écriture (structure, ' +
          'doublons fichier ET base, références organisationnelles par code, poste actif à la date) : la moindre ' +
          'erreur ⇒ 422 avec rapport PAR LIGNE et ZÉRO insertion. Les valeurs CNSS/fiscales ne figurent JAMAIS dans ' +
          'les rapports. Seule la stratégie create_only est implémentée — les mises à jour par import sont un ' +
          'incrément ultérieur (NOT IMPLEMENTED).',
        security: bearer,
        responses: { '200': { description: '{ mode, counts } (preview valide ou import appliqué)' }, '422': err('Rapport d’erreurs par ligne — aucune écriture') },
      },
    },
    '/hr/changes/{id}': {
      get: {
        summary: 'Suivre un changement RH soumis au workflow (pending/applied/rejected/cancelled/conflict) — employees.view',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Changement + statut' }, '404': err('Introuvable') },
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
    '/notifications': {
      get: {
        summary: 'Mes notifications (in-app) — toujours bornées à l’utilisateur de la session',
        security: bearer,
        parameters: [
          { name: 'unread', in: 'query', required: false, schema: { type: 'string', enum: ['1', 'true'] }, description: 'non lues uniquement' },
          { name: 'includeArchived', in: 'query', required: false, schema: { type: 'string', enum: ['1', 'true'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 200 } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: '{ items[], unreadCount } — contenu rendu (langue du destinataire)' } },
      },
    },
    '/notifications/{id}': {
      get: {
        summary: 'Une de MES notifications (celle d’un autre utilisateur : 404, jamais révélée)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Notification + livraisons par canal' }, '404': err('Introuvable (ou pas la vôtre)') },
      },
    },
    '/notifications/{id}/read': {
      post: {
        summary: 'Marquer comme lue (idempotent)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ read: true }' }, '404': err('Introuvable (ou pas la vôtre)') },
      },
    },
    '/notifications/{id}/archive': {
      post: {
        summary: 'Archiver (marque aussi comme lue, idempotent)',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ archived: true }' }, '404': err('Introuvable (ou pas la vôtre)') },
      },
    },
    '/notifications/preferences': {
      get: {
        summary: 'Mes préférences de notification (langue + canaux sortants)',
        security: bearer,
        responses: { '200': { description: '{ locale, channels: { email, sms, push } } — in_app non désactivable (socle)' } },
      },
      put: {
        summary: 'Régler langue (fr/en) et canaux sortants — les notifications OBLIGATOIRES ignorent ces préférences',
        security: bearer,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  locale: { type: 'string', enum: ['fr', 'en'] },
                  channels: {
                    type: 'object',
                    properties: { email: { type: 'boolean' }, sms: { type: 'boolean' }, push: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Préférences effectives' }, '400': err('Canal inconnu ou non désactivable (in_app)') },
      },
    },
    '/admin/notify/templates': {
      post: {
        summary: 'Créer un modèle (draft, bilingue FR/EN, variables contrôlées) — notify.manage, audité',
        security: bearer,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['key', 'name', 'subjectFr', 'subjectEn', 'bodyFr', 'bodyEn'],
                properties: {
                  key: { type: 'string', maxLength: 100 },
                  name: { type: 'string', maxLength: 200 },
                  subjectFr: { type: 'string', maxLength: 200 },
                  subjectEn: { type: 'string', maxLength: 200 },
                  bodyFr: { type: 'string', maxLength: 4000 },
                  bodyEn: { type: 'string', maxLength: 4000 },
                  variables: { type: 'array', items: { type: 'string' }, description: 'liste fermée — noms de secrets/médicaux interdits' },
                  channels: { type: 'array', items: { type: 'string', enum: ['in_app', 'email', 'sms', 'push'] }, description: 'in_app obligatoire (socle)' },
                  mandatory: { type: 'boolean', description: 'non désactivable par préférence utilisateur' },
                },
              },
            },
          },
        },
        responses: { '201': { description: '{ id, version } — version auto-incrémentée par clé' }, '400': err('Modèle invalide (placeholder hors liste, nom interdit, secret embarqué…)'), '403': err('Permission absente') },
      },
      get: { summary: 'Lister les modèles (toutes versions) — notify.manage', security: bearer, responses: { '200': { description: 'Modèles du tenant uniquement' } } },
    },
    '/admin/notify/templates/{id}': {
      get: { summary: 'Consulter un modèle — notify.manage', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Modèle complet' }, '404': err('Introuvable') } },
      patch: { summary: 'Modifier un DRAFT (un modèle sorti de draft est figé) — notify.manage, audité', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Draft mis à jour' }, '400': err('Invalide ou non draft'), '404': err('Introuvable') } },
    },
    '/admin/notify/templates/{id}/activate': {
      post: { summary: 'Activer un draft (supersède l’active précédente de la même clé) — notify.manage, audité', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Activé' }, '400': err('Non draft'), '404': err('Introuvable') } },
    },
    '/admin/notify/templates/{id}/retire': {
      post: { summary: 'Retirer un modèle — notify.manage, audité', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Retiré' }, '404': err('Introuvable ou déjà retiré') } },
    },
    '/admin/notify/events': {
      post: {
        summary: 'Publier un événement métier (idempotent par eventKey) — notify.manage, audité via l’événement',
        description:
          'Destinataires par userId, roleKey ou portée organisationnelle. Variables contrôlées : ' +
          'inconnues/manquantes ⇒ 400 AVANT tout envoi ; secrets (mot de passe, jeton, MFA…) et noms ' +
          'médicaux ⇒ 400 (filtre anti-secrets). Rejouer le même eventKey ⇒ duplicate:true, aucun doublon.',
        security: bearer,
        responses: { '201': { description: '{ eventId, duplicate, recipients, inApp, queued }' }, '400': err('Variables invalides ou refusées (sécurité)'), '404': err('Aucun modèle actif pour cette clé') },
      },
    },
    '/admin/notify/queue': {
      get: {
        summary: 'Consulter la file de livraison (métadonnées SANS contenu) — notify.manage',
        security: bearer,
        parameters: [
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'processing', 'sent', 'failed', 'cancelled', 'dead_letter'] } },
          { name: 'channel', in: 'query', required: false, schema: { type: 'string', enum: ['in_app', 'email', 'sms', 'push'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 200 } },
        ],
        responses: { '200': { description: 'Livraisons du tenant uniquement' } },
      },
    },
    '/admin/notify/queue/process': {
      post: {
        summary: 'Traiter les livraisons dues (retries à backoff, dead_letter à épuisement) — notify.manage',
        description: 'Transport SIMULÉ (DEMO/TEST ONLY) : aucun fournisseur email/SMS/push payant branché. En production, appelé par un déclencheur planifié.',
        security: bearer,
        responses: { '200': { description: '{ processed, sent, failed, deadLettered }' } },
      },
    },
    '/admin/notify/deliveries/{id}/attempts': {
      get: { summary: 'Journal des tentatives d’une livraison (append-only, sans contenu ni secret) — notify.manage', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Tentatives ordonnées' } } },
    },
    '/admin/notify/deliveries/{id}/cancel': {
      post: { summary: 'Annuler une livraison pending/failed — notify.manage, audité', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: '{ status: cancelled }' }, '400': err('État incompatible'), '404': err('Introuvable') } },
    },
    '/admin/notify/deliveries/{id}/requeue': {
      post: { summary: 'Requeue d’une livraison dead_letter/cancelled (compteur remis à zéro) — notify.manage, audité', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: '{ status: pending }' }, '400': err('État incompatible'), '404': err('Introuvable') } },
    },
    '/audit/events': {
      get: {
        summary: 'Consulter le journal d’audit (LECTURE SEULE) — vue selon permissions : audit.view (tout), audit.view_<module>, audit.view_own',
        description:
          'Le périmètre de vue est résolu par permission puis INTERSECTÉ avec les filtres : un filtre ne peut ' +
          'qu’étrécir, jamais élargir (ni contourner la RLS tenant). Valeurs sensibles systématiquement masquées. ' +
          'Pagination STABLE par curseur (id décroissant). Les consultations au-delà de ses propres événements ' +
          'laissent une trace d’audit distincte (audit_consulted).',
        security: bearer,
        parameters: [
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'actorUserId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
          { name: 'action', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'module', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'recordType', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'recordId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'result', in: 'query', required: false, schema: { type: 'string', enum: ['success', 'denied', 'failure'] } },
          { name: 'correlationId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
          { name: 'employeeId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'id de la dernière ligne vue (nextCursor de la page précédente)' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 200 } },
        ],
        responses: { '200': { description: '{ items[], nextCursor } — sans old/new (voir détail)' }, '400': err('Filtre ou curseur invalide'), '403': err('Aucune permission de consultation d’audit') },
      },
    },
    '/audit/events/{id}': {
      get: {
        summary: 'Détail d’un événement (horodatage, acteur, contexte, old/new MASQUÉS) — consultation tracée',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Événement complet, valeurs sensibles masquées' }, '403': err('Aucune permission d’audit'), '404': err('Introuvable ou hors périmètre de vue') },
      },
    },
    '/audit/integrity': {
      get: {
        summary: 'Vérifier l’intégrité de la chaîne de hachage — statut valid | broken | unverified (audit.view)',
        description:
          'Vérification BORNÉE (maxRows) et REPRENABLE : si unverified, continuer avec (afterId, seed) retournés — ' +
          'la reprise est cryptographique (seed = hash du segment vérifié précédent). AUCUNE réparation n’existe ' +
          'dans l’API : le journal est append-only, la rupture se constate, elle ne se corrige pas. Chaque ' +
          'vérification laisse une trace d’audit (audit_integrity_checked).',
        security: bearer,
        parameters: [
          { name: 'maxRows', in: 'query', required: false, schema: { type: 'integer', minimum: 100, maximum: 50000 } },
          { name: 'afterId', in: 'query', required: false, schema: { type: 'string' }, description: 'reprise : dernier id vérifié' },
          { name: 'seed', in: 'query', required: false, schema: { type: 'string' }, description: 'reprise : hash (sha256 hex) du dernier segment vérifié' },
        ],
        responses: { '200': { description: '{ status, checked, lastId, brokenAtId?, nextAfterId?, nextSeed? }' }, '400': err('Reprise incohérente'), '403': err('Permission audit.view requise') },
      },
    },
    '/audit/export/csv': {
      get: {
        summary: 'Exporter le journal filtré en CSV (audit.export) — export borné à la visibilité de l’acteur, lui-même audité',
        description: 'Mêmes filtres que /audit/events. RFC 4180, BOM UTF-8, anti-injection de formules tableur, valeurs sensibles masquées. Plafond de volume (limit ≤ 10000).',
        security: bearer,
        responses: { '200': { description: 'text/csv (pièce jointe)' }, '403': err('Permission audit.export requise') },
      },
    },
    '/audit/export/json': {
      get: {
        summary: 'Exporter le journal filtré en JSON (audit.export) — borné à la visibilité, audité, masqué',
        security: bearer,
        responses: { '200': { description: '{ count, items[] }' }, '403': err('Permission audit.export requise') },
      },
    },
    '/org/companies': {
      post: { summary: 'Créer une société/entité juridique DANS le tenant (code unique, libellés FR/EN) — org.manage, audité', security: bearer, responses: { '201': { description: '{ id }' }, '400': err('Entrée invalide'), '409': err('Code déjà utilisé (code=duplicate_code)') } },
      get: { summary: 'Lister/rechercher les sociétés (query, status, limit, offset) — org.view', security: bearer, responses: { '200': { description: 'Sociétés du tenant' } } },
    },
    '/org/sites': {
      post: { summary: 'Créer un site/établissement rattaché à une société — org.manage, audité', security: bearer, responses: { '201': { description: '{ id }' }, '400': err('Référence introuvable'), '409': err('Code déjà utilisé') } },
      get: { summary: 'Lister/rechercher les sites — org.view', security: bearer, responses: { '200': { description: 'Sites du tenant' } } },
    },
    '/org/cost-centers': {
      post: { summary: 'Créer un centre de coûts — org.manage, audité', security: bearer, responses: { '201': { description: '{ id }' }, '409': err('Code déjà utilisé') } },
      get: { summary: 'Lister/rechercher les centres de coûts — org.view', security: bearer, responses: { '200': { description: 'Centres de coûts' } } },
    },
    '/org/jobs': {
      post: { summary: 'Créer un emploi générique — org.manage, audité', security: bearer, responses: { '201': { description: '{ id }' }, '409': err('Code déjà utilisé') } },
      get: { summary: 'Lister/rechercher les emplois — org.view', security: bearer, responses: { '200': { description: 'Emplois' } } },
    },
    '/org/units': {
      post: { summary: 'Créer une unité (direction/département/service/unité/équipe), parent daté optionnel — org.manage, audité', security: bearer, responses: { '201': { description: '{ id }' }, '400': err('unit_type ou parent invalide'), '409': err('Code déjà utilisé') } },
      get: { summary: 'Lister/rechercher les unités (type, status, date pour le parent applicable) — org.view', security: bearer, responses: { '200': { description: 'Unités + parent applicable à la date' } } },
    },
    '/org/units/{id}': {
      get: { summary: 'Détail d’une unité + HISTORIQUE complet de ses rattachements datés — org.view', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Unité + parentHistory[]' }, '404': err('Introuvable') } },
    },
    '/org/units/{id}/move': {
      post: {
        summary: 'Déplacer une unité (réorganisation datée) — org.manage + PORTÉE organisationnelle réelle sur l’unité',
        description:
          'Clôt la période hiérarchique courante à la date d’effet et ouvre une nouvelle ligne — l’historique ' +
          'antérieur n’est JAMAIS réécrit. Anti-cycle vérifié à la date. Avec workflowDefinitionKey : le changement ' +
          'devient un pending_change soumis au Workflow Engine (appliqué à l’approbation, statut conflict si l’état a ' +
          'bougé entre-temps). Notification org.unit_moved via E5 si un modèle actif existe.',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '{ moved } ou { submitted, pendingChangeId, workflowInstanceId }' }, '403': err('Portée insuffisante'), '404': err('Unité ou définition introuvable'), '409': err('Cycle (code=cycle)') },
      },
    },
    '/org/positions': {
      post: { summary: 'Créer un poste + rattachements datés (unité, société, emploi, site?, centre de coûts?, manager?) — org.manage, audité', security: bearer, responses: { '201': { description: '{ id }' }, '400': err('Référence introuvable'), '409': err('Code déjà utilisé') } },
      get: { summary: 'Lister/rechercher les postes (unitId, date, status) — org.view', security: bearer, responses: { '200': { description: 'Postes + rattachement applicable à la date' } } },
    },
    '/org/positions/{id}': {
      get: { summary: 'Détail d’un poste + historiques datés (rattachements, managers) — org.view', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Poste + assignmentHistory[] + managerHistory[]' }, '404': err('Introuvable') } },
    },
    '/org/positions/{id}/manager-line': {
      get: { summary: 'Ligne managériale du poste à une date (résolution d’approbateur E3 par ligne hiérarchique)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }], responses: { '200': { description: '{ date, managers[] } (chaîne ascendante)' }, '404': err('Introuvable') } },
    },
    '/org/chart': {
      get: { summary: 'Organigramme des unités À UNE DATE (arbre) — une réorganisation future ne change pas le passé', security: bearer, parameters: [{ name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }, { name: 'rootUnitId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: '{ date, tree[] }' } } },
    },
    '/org/{entity}/{id}/status': {
      post: {
        summary: 'Changer le statut (draft→active⇄inactive→archived, archived terminal) — org.manage, audité avec old/new',
        description: 'Une unité avec enfants ou postes ACTIFS ne se désactive pas (409 children_active) : aucun orphelin. Aucune suppression physique n’existe.',
        security: bearer,
        parameters: [
          { name: 'entity', in: 'path', required: true, schema: { type: 'string', enum: ['companies', 'sites', 'cost-centers', 'jobs', 'units', 'positions'] } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: '{ status }' }, '400': err('Transition interdite'), '404': err('Introuvable'), '409': err('Dépendances actives (code=children_active)') },
      },
    },
    '/org/changes/{id}': {
      get: { summary: 'Suivre un changement structurel soumis au workflow (pending/applied/rejected/conflict) — org.view', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Changement + statut' }, '404': err('Introuvable') } },
    },
    '/org/import': {
      post: {
        summary: 'Import initial CSV (preview | apply ATOMIQUE) — org.import, audité',
        description:
          'Colonnes : kind, code, label_fr, label_en, unit_type, parent_code, unit_code, company_code, site_code, ' +
          'job_code, cost_center_code, manager_position_code, effective_from, city, category, legal_form. ' +
          'Validation COMPLÈTE avant toute écriture (cycles, doublons, références, collisions avec l’existant) : la ' +
          'moindre erreur ⇒ 422 avec rapport par ligne et ZÉRO insertion — jamais d’insertion partielle silencieuse. ' +
          'Les références se résolvent PAR CODE dans le tenant courant : aucune référence croisée inter-tenant possible.',
        security: bearer,
        responses: { '200': { description: '{ mode, counts } (preview valide ou import appliqué)' }, '422': err('Rapport d’erreurs par ligne — aucune écriture') },
      },
    },
    '/openapi.json': {
      get: { summary: 'Cette spécification', responses: { '200': { description: 'OpenAPI 3.0.3' } } },
    },
  },
} as const;
