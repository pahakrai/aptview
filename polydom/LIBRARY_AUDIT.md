# Library Architecture Audit

**Date**: 2026-04-08  
**Phase**: 1 (Dependency Audit & Documentation)

## Executive Summary
The shared libraries are predominantly **NestJS-coupled**, which is acceptable for this all-NestJS monorepo. Framework lock-in is a conscious trade-off for development velocity. Recommendations include documenting assumptions and considering adapter pattern for `utils` library.

## Detailed Findings

### 1. Framework Coupling Analysis

| Library | Coupling | NestJS Imports | Notes |
|---------|----------|----------------|--------|
| `shared-types` | 🟢 None | 0 | Pure TypeScript interfaces |
| `kafka-client` | 🟡 NestJS-coupled | 2 files | `BaseProducer`, `BaseConsumer` (Kafka API-compatible, Redpanda-backed) |
| `database-client` | 🟡 NestJS-coupled | 3 files | `PostgresClient`, `MongoDBClient`, `RedisClient` use `@Injectable()` |
| `elasticsearch-client` | 🟡 Mixed | 1 file | Client is NestJS, query builders are framework-agnostic |
| `utils` | 🟡 Mixed | 1 file | `CustomLogger` is NestJS, validators/transformers are framework-agnostic |

**Total NestJS-coupled files**: 7  
**Total framework-agnostic files**: 10+ (excluding types)

### 2. Dependency Analysis
- **Root `package.json`**: No `@nestjs/common` dependency (expected - provided by services)
- **Service `package.json`**: `@nestjs/common` present in each NestJS service
- **Library dependencies**: Libraries assume `@nestjs/common` will be provided by consumer
- **Missing clients**: Kafka, Elasticsearch, Redis, MongoDB clients not installed (stub implementations)

### 3. Current Implementation Status
| Library | Status | Notes |
|---------|--------|-------|
| `shared-types` | ✅ Complete | All domain interfaces defined |
| `kafka-client` | ✅ Complete | Kafka API-compatible producer/consumer (Redpanda) |
| `database-client` | 🚧 Stub | Placeholder implementations with TODOs |
| `elasticsearch-client` | 🚧 Partial | Query builders complete, client stub |
| `utils` | ✅ Partial | Validators/transformers complete, logger stub |

## Recommendations

### Phase 1 (Immediate) - ✅ COMPLETED
1. **Document library coupling** - README files added to each library
2. **Audit dependencies** - Analysis complete (this document)
3. **Verify `shared-types` framework-agnostic** - Confirmed ✅

### Phase 2 (Optional)
1. **Refactor `utils` library** to adapter pattern
   - Create framework-agnostic `Logger` interface
   - Implement `ConsoleLogger` (framework-agnostic)
   - Create `NestLoggerAdapter` (NestJS adapter)
   - Deprecate `CustomLogger`

2. **Consider peerDependencies** for NestJS-coupled libraries
   - Add `@nestjs/common` as peerDependency in library `package.json` files
   - Currently not needed due to workspace setup

### Phase 3 (Long-term)
1. **Monitor reuse needs** - Refactor only if libraries needed outside NestJS
2. **Evaluate adapter pattern** for other libraries if multi-framework support needed
3. **Consider extraction** of truly reusable logic to framework-agnostic packages

## Risk Assessment

### Low Risk (Acceptable)
- **Framework lock-in**: All services use NestJS, no immediate plans to change
- **Testing complexity**: NestJS testing utilities are mature and well-documented
- **Dependency bloat**: `@nestjs/common` already required by all services

### Medium Risk (Monitor)
- **Future flexibility**: If any service needs non-NestJS framework, libraries would need refactoring
- **Open-source potential**: Coupled libraries cannot be shared with broader community
- **Team onboarding**: New developers must learn NestJS to use libraries

## Verification

```bash
# Check NestJS imports
grep -r "@nestjs/common" libs/ --include="*.ts"

# Check @Injectable usage  
grep -r "@Injectable" libs/ --include="*.ts"

# Build all libraries
nx run-many --target=build --projects=shared-types,kafka-client,database-client,elasticsearch-client,utils
```

## Conclusion
The current NestJS-coupled library architecture is **pragmatic and acceptable** for this monorepo. The trade-off of framework lock-in for development velocity is justified. Documentation has been added to clarify coupling assumptions. Consider Phase 2 refactoring only if actual reuse outside NestJS becomes a requirement.