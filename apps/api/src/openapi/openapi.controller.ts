import { Controller, Get } from '@nestjs/common';
import { OPENAPI_SPEC } from './openapi.spec';

@Controller('openapi.json')
export class OpenapiController {
  @Get()
  spec(): typeof OPENAPI_SPEC {
    return OPENAPI_SPEC;
  }
}
