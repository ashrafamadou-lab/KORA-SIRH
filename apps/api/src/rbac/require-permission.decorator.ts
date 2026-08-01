import { SetMetadata } from '@nestjs/common';

export const PERMISSION_METADATA_KEY = 'kora:required_permission';

/** Déclare la permission (module.action) exigée par un handler — évaluée par PermissionsGuard. */
export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_METADATA_KEY, permission);
