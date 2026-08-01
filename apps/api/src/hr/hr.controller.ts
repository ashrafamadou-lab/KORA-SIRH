import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { HrService, type AssignmentOutcome, type StatusChangeOutcome } from './hr.service';
import { HrImportService } from './hr-import.service';
import type { EmployeeStatus } from '../../../../packages/core/src/hr.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYEE_STATUSES = ['draft', 'pre_hire', 'active', 'suspended', 'on_leave', 'terminated', 'archived'];

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}
function optUuid(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return uuid(v, field);
}
function str(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return v;
}
function optStr(body: Record<string, unknown>, field: string, max = 200): string | undefined {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`champ « ${field} » invalide`);
  return v;
}
/** Champ modifiable : absent = inchangé, null = effacé, chaîne = nouvelle valeur. */
function patchStr(body: Record<string, unknown>, field: string, max = 200): string | null | undefined {
  if (!(field in body)) return undefined;
  const v = body[field];
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`champ « ${field} » invalide`);
  return v;
}
function single(v: string | string[] | undefined, field: string): string | undefined {
  if (Array.isArray(v)) throw new BadRequestException(`paramètre « ${field} » répété`);
  return v;
}
function dateOrToday(v: string | string[] | undefined, field: string): string {
  const s = single(v, field);
  if (s === undefined || s === '') return new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(s)) throw new BadRequestException(`« ${field} » : AAAA-MM-JJ`);
  return s;
}

function notFound(): never {
  throw new HttpException('dossier salarié introuvable', 404);
}

/**
 * Dossier salarié (E9). Les routes PAR SALARIÉ n'utilisent pas @RequirePermission :
 * la garde v1 exigerait la portée tenant, alors que E9 introduit les PORTÉES RÉELLES
 * (E2×E8) — le service vérifie permission + portée PAR CIBLE : lecture hors périmètre
 * = 404 (aucune divulgation), écriture hors périmètre = 403. Les routes de niveau
 * tenant (création, import) gardent la garde déclarative.
 */
@Controller('employees')
@UseGuards(SessionGuard, PermissionsGuard)
export class HrController {
  constructor(private readonly hr: HrService) {}

  // ---------------- liste et détail (zone professionnelle uniquement) ----------------

  @Get()
  async list(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const status = single(q['status'], 'status');
    if (status !== undefined && !EMPLOYEE_STATUSES.includes(status)) throw new BadRequestException('status inconnu');
    const query = single(q['query'], 'query');
    const out = await this.hr.list(a.tenantId, a.userId, {
      query: query && query.length <= 100 ? query : undefined,
      status,
      companyId: optUuid(single(q['companyId'], 'companyId'), 'companyId'),
      siteId: optUuid(single(q['siteId'], 'siteId'), 'siteId'),
      unitId: optUuid(single(q['unitId'], 'unitId'), 'unitId'),
      limit: single(q['limit'], 'limit') ? Number(single(q['limit'], 'limit')) : undefined,
      offset: single(q['offset'], 'offset') ? Number(single(q['offset'], 'offset')) : undefined,
    });
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') throw new BadRequestException('requête invalide');
    return { items: out.items, count: out.items.length, limit: 200 };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.get(a.tenantId, a.userId, uuid(id, 'id'));
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return out.employee;
  }

  // ---------------- création et zone professionnelle (employees.manage) ----------------

  @Post()
  @HttpCode(201)
  @RequirePermission('employees.manage')
  async create(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.create(a.tenantId, a.userId, {
      matricule: str(b, 'matricule', 30).toUpperCase(),
      firstName: str(b, 'firstName'), lastName: str(b, 'lastName'),
      usageFirstName: optStr(b, 'usageFirstName'), usageLastName: optStr(b, 'usageLastName'),
      hireDate: optStr(b, 'hireDate', 10), professionalStatus: optStr(b, 'professionalStatus', 100),
      employerCompanyId: optUuid(b['employerCompanyId'], 'employerCompanyId'),
      mainSiteId: optUuid(b['mainSiteId'], 'mainSiteId'),
      workEmail: optStr(b, 'workEmail'), workPhone: optStr(b, 'workPhone', 30), photoRef: optStr(b, 'photoRef', 300),
    });
    switch (out.kind) {
      case 'ok': return { id: out.id, status: 'draft' };
      case 'duplicate_matricule':
        throw new HttpException({ statusCode: 409, message: 'matricule déjà utilisé dans ce tenant', code: 'duplicate_matricule' }, 409);
      case 'ref_not_found': throw new BadRequestException(`référence introuvable : ${out.ref}`);
      case 'invalid': throw new BadRequestException(out.reason);
    }
  }

  @Patch(':id')
  async updateProfessional(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    if ('matricule' in b) throw new BadRequestException('le matricule est immuable');
    if ('status' in b) throw new BadRequestException('le statut se change via POST /employees/:id/status');
    const out = await this.hr.updateProfessional(a.tenantId, a.userId, uuid(id, 'id'), {
      firstName: patchStr(b, 'firstName'), lastName: patchStr(b, 'lastName'),
      usageFirstName: patchStr(b, 'usageFirstName'), usageLastName: patchStr(b, 'usageLastName'),
      hireDate: patchStr(b, 'hireDate', 10), professionalStatus: patchStr(b, 'professionalStatus', 100),
      employerCompanyId: patchStr(b, 'employerCompanyId', 36), mainSiteId: patchStr(b, 'mainSiteId', 36),
      workEmail: patchStr(b, 'workEmail'), workPhone: patchStr(b, 'workPhone', 30), photoRef: patchStr(b, 'photoRef', 300),
    });
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind === 'invalid') throw new BadRequestException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { updated: true };
  }

  // ---------------- zones protégées (permissions dédiées, lectures AUDITÉES) ----------------

  @Get(':id/private')
  async getPrivate(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.getPrivate(a.tenantId, a.userId, uuid(id, 'id'));
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { private: out.private };
  }

  @Put(':id/private')
  async putPrivate(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.putPrivate(a.tenantId, a.userId, uuid(id, 'id'), {
      birthDate: patchStr(b, 'birthDate', 10), birthPlace: patchStr(b, 'birthPlace'),
      nationality: patchStr(b, 'nationality', 2), sex: patchStr(b, 'sex', 1),
      personalEmail: patchStr(b, 'personalEmail'), personalPhone: patchStr(b, 'personalPhone', 30),
      addressLine: patchStr(b, 'addressLine', 300), addressCity: patchStr(b, 'addressCity'),
      addressCountry: patchStr(b, 'addressCountry', 2),
      emergencyName: patchStr(b, 'emergencyName'), emergencyRelation: patchStr(b, 'emergencyRelation', 100),
      emergencyPhone: patchStr(b, 'emergencyPhone', 30),
    });
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind === 'invalid') throw new BadRequestException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { updated: true };
  }

  @Get(':id/identifiers')
  async getIdentifiers(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.getIdentifiers(a.tenantId, a.userId, uuid(id, 'id'));
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { identifiers: out.identifiers };
  }

  @Put(':id/identifiers')
  async putIdentifiers(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.putIdentifiers(a.tenantId, a.userId, uuid(id, 'id'), {
      cnssNumber: patchStr(b, 'cnssNumber', 50), taxId: patchStr(b, 'taxId', 50),
      idDocumentType: patchStr(b, 'idDocumentType', 20), idDocumentNumber: patchStr(b, 'idDocumentNumber', 50),
      idDocumentExpiry: patchStr(b, 'idDocumentExpiry', 10),
    });
    if (out.kind === 'duplicate_cnss') {
      // Le numéro n'est JAMAIS renvoyé — pas d'oracle de valeurs.
      throw new HttpException({ statusCode: 409, message: 'numéro CNSS déjà rattaché à un autre dossier', code: 'duplicate_cnss' }, 409);
    }
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind === 'invalid') throw new BadRequestException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { updated: true };
  }

  @Get(':id/documents')
  async listDocuments(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.listDocuments(a.tenantId, a.userId, uuid(id, 'id'));
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { documents: out.documents };
  }

  @Post(':id/documents')
  @HttpCode(201)
  async addDocument(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const sensitive = b['sensitive'];
    if (sensitive !== undefined && typeof sensitive !== 'boolean') throw new BadRequestException('sensitive : booléen');
    const out = await this.hr.addDocument(a.tenantId, a.userId, uuid(id, 'id'), {
      docType: str(b, 'docType', 20), label: str(b, 'label'), fileRef: optStr(b, 'fileRef', 300),
      sensitive: sensitive as boolean | undefined,
    });
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind === 'invalid') throw new BadRequestException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { id: out.id };
  }

  // ---------------- cycle de vie et affectations ----------------

  @Post(':id/status')
  @HttpCode(200)
  async changeStatus(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const status = str(b, 'status', 20);
    if (!EMPLOYEE_STATUSES.includes(status)) throw new BadRequestException('statut inconnu');
    const out: StatusChangeOutcome = await this.hr.changeStatus(a.tenantId, a.userId, uuid(id, 'id'), {
      status: status as EmployeeStatus,
      effectiveDate: optStr(b, 'effectiveDate', 10),
      reason: optStr(b, 'reason', 200),
      workflowDefinitionKey: optStr(b, 'workflowDefinitionKey', 100),
    });
    switch (out.kind) {
      case 'ok': return { status: out.status, effectiveDate: out.effectiveDate, careerEvent: out.careerEvent };
      case 'submitted': return { submitted: true, pendingChangeId: out.pendingChangeId, workflowInstanceId: out.workflowInstanceId };
      case 'not_found': notFound();
      case 'forbidden': throw new ForbiddenException(out.reason);
      case 'invalid_transition': throw new BadRequestException(`transition interdite depuis « ${out.from} »`);
      case 'invalid': throw new BadRequestException(out.reason);
      case 'no_active_definition': throw new HttpException('aucune définition de workflow active pour cette clé', 404);
    }
  }

  @Post(':id/assignments')
  @HttpCode(201)
  async createAssignment(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const isPrimary = b['isPrimary'];
    if (isPrimary !== undefined && typeof isPrimary !== 'boolean') throw new BadRequestException('isPrimary : booléen');
    const pct = b['allocationPct'];
    if (pct !== undefined && typeof pct !== 'number') throw new BadRequestException('allocationPct : nombre');
    const out: AssignmentOutcome = await this.hr.createAssignment(a.tenantId, a.userId, uuid(id, 'id'), {
      companyId: uuid(b['companyId'], 'companyId'), unitId: uuid(b['unitId'], 'unitId'),
      siteId: optUuid(b['siteId'], 'siteId'), positionId: optUuid(b['positionId'], 'positionId'),
      jobId: optUuid(b['jobId'], 'jobId'), costCenterId: optUuid(b['costCenterId'], 'costCenterId'),
      managerOverrideEmployeeId: optUuid(b['managerOverrideEmployeeId'], 'managerOverrideEmployeeId'),
      isPrimary: isPrimary as boolean | undefined,
      assignmentKind: optStr(b, 'assignmentKind', 20),
      allocationPct: pct as number | undefined,
      effectiveFrom: str(b, 'effectiveFrom', 10),
      effectiveTo: optStr(b, 'effectiveTo', 10),
      careerEventType: optStr(b, 'careerEventType', 30),
      workflowDefinitionKey: optStr(b, 'workflowDefinitionKey', 100),
    });
    switch (out.kind) {
      case 'ok': return { id: out.id, careerEvent: out.careerEvent };
      case 'submitted': return { submitted: true, pendingChangeId: out.pendingChangeId, workflowInstanceId: out.workflowInstanceId };
      case 'not_found': notFound();
      case 'forbidden': throw new ForbiddenException(out.reason);
      case 'ref_not_found': throw new BadRequestException(`référence introuvable : ${out.ref}`);
      case 'position_not_active':
        throw new HttpException({ statusCode: 409, message: 'le poste doit être ACTIF et rattaché à l\'organisation à la date d\'effet', code: 'position_not_active' }, 409);
      case 'invalid': throw new BadRequestException(out.reason);
      case 'no_active_definition': throw new HttpException('aucune définition de workflow active pour cette clé', 404);
    }
  }

  @Get(':id/assignments')
  async listAssignments(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.listAssignments(a.tenantId, a.userId, uuid(id, 'id'));
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { assignments: out.assignments };
  }

  @Get(':id/career')
  async listCareer(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const out = await this.hr.listCareer(a.tenantId, a.userId, uuid(id, 'id'));
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { events: out.events };
  }

  @Get(':id/at')
  async atDate(@Param('id') id: string, @Query('date') date: string | string[] | undefined, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const d = dateOrToday(date, 'date');
    const out = await this.hr.atDate(a.tenantId, a.userId, uuid(id, 'id'), d);
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return out.at;
  }

  @Get(':id/manager')
  async manager(@Param('id') id: string, @Query('date') date: string | string[] | undefined, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const d = dateOrToday(date, 'date');
    const out = await this.hr.getManager(a.tenantId, a.userId, uuid(id, 'id'), d);
    if (out.kind === 'forbidden') throw new ForbiddenException(out.reason);
    if (out.kind !== 'ok') notFound();
    return { date: out.date, manager: out.manager };
  }
}

/** Routes RH de niveau tenant : import CSV atomique et suivi des changements soumis. */
@Controller('hr')
@UseGuards(SessionGuard, PermissionsGuard)
export class HrAdminController {
  constructor(
    private readonly hr: HrService,
    private readonly hrImport: HrImportService,
  ) {}

  @Post('import')
  @HttpCode(200)
  @RequirePermission('employees.import')
  async import(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const mode = str(b, 'mode', 10);
    if (mode !== 'preview' && mode !== 'apply') throw new BadRequestException('mode : preview ou apply');
    // Stratégie EXPLICITE : create_only seulement — les mises à jour par import sont
    // un incrément ultérieur (NOT IMPLEMENTED), jamais un comportement implicite.
    const strategy = str(b, 'strategy', 20);
    if (strategy !== 'create_only') {
      throw new BadRequestException('strategy : seule « create_only » est implémentée (les stratégies de mise à jour arrivent dans un incrément ultérieur)');
    }
    const csv = b['csv'];
    if (typeof csv !== 'string' || csv.length === 0) throw new BadRequestException('csv requis');
    const outcome = await this.hrImport.run(a.tenantId, a.userId, {
      csv, mode, defaultEffectiveFrom: optStr(b, 'defaultEffectiveFrom', 10),
    });
    switch (outcome.kind) {
      case 'invalid':
        // 422 : rapport par ligne, AUCUNE écriture effectuée.
        throw new HttpException({ statusCode: 422, message: 'import refusé — aucune écriture', errors: outcome.errors, counts: outcome.counts }, 422);
      case 'preview_ok': return { mode: 'preview', valid: true, counts: outcome.counts };
      case 'applied': return { mode: 'apply', applied: true, counts: outcome.counts };
    }
  }

  @Get('changes/:id')
  @RequirePermission('employees.view')
  async getChange(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const change = await this.hr.getPendingChange(a.tenantId, uuid(id, 'id'));
    if (!change) throw new HttpException('changement introuvable', 404);
    return change;
  }
}
