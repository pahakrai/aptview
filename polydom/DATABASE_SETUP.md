## Database Setup with Drizzle ORM and Neon (Microservices Architecture)

The project uses Drizzle ORM with PostgreSQL (Neon for serverless) for data persistence. Each microservice has its own database and manages its own schema, migrations, and seed data.

### Database per Service

Each microservice has its own PostgreSQL database:

| Service | Database | Description |
|---------|----------|-------------|
| API Gateway | `gateway_db` | API gateway specific data (rate limiting, API keys) |
| Auth Service | `auth_db` | User authentication, login/logout activities |
| User Service | `user_db` | User profiles, user activities |
| Vendor Service | `vendor_db` | Vendor profiles, venues |
| Event Service | `event_db` | Events created by vendors |
| Booking Service | `booking_db` | User bookings for events |
| Notification Service | `notification_db` | Notification templates, user preferences |
| Analytics Service | `analytics_db` | Analytics data, aggregated metrics |
| Admin Service | `admin_db` | Admin operations, reporting |

### Schema per Service

Each service defines its own Drizzle schema in `src/database/schema.ts`:

- **auth-service**: `users` (authentication), `user_activities` (login/logout)
- **user-service**: `users` (profiles), `user_activities` (user actions)
- **vendor-service**: `vendors`, `venues`
- **event-service**: `events`
- **booking-service**: `bookings`
- **notification-service**: `notifications` (to be defined)
- **analytics-service**: `analytics_events` (to be defined)
- **admin-service**: Read-only access to all databases via API calls

### Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start PostgreSQL with Docker (creates all service databases):**
   ```bash
   npm run docker:up
   ```

3. **Run migrations for a specific service:**
   ```bash
   # Example: Run migrations for auth service
   npm run db:migrate:auth

   # Or navigate to the service and run its scripts
   cd apps/nestjs-services/auth-service
   npm run db:migrate
   ```

4. **Seed a specific service database:**
   ```bash
   npm run db:seed:auth
   ```

5. **Open Drizzle Studio for a service:**
   ```bash
   npm run db:studio:auth
   ```

### Environment Variables

Create a `.env` file with database URLs for each service:

```bash
# Database URLs for each microservice
GATEWAY_DATABASE_URL=postgresql://username:password@localhost:5432/gateway_db
AUTH_DATABASE_URL=postgresql://username:password@localhost:5432/auth_db
USER_DATABASE_URL=postgresql://username:password@localhost:5432/user_db
VENDOR_DATABASE_URL=postgresql://username:password@localhost:5432/vendor_db
EVENT_DATABASE_URL=postgresql://username:password@localhost:5432/event_db
BOOKING_DATABASE_URL=postgresql://username:password@localhost:5432/booking_db
NOTIFICATION_DATABASE_URL=postgresql://username:password@localhost:5432/notification_db
ANALYTICS_DATABASE_URL=postgresql://username:password@localhost:5432/analytics_db
ADMIN_DATABASE_URL=postgresql://username:password@localhost:5432/admin_db

# Neon Database URLs (for production/staging)
NEON_GATEWAY_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/gateway_db?sslmode=require
NEON_AUTH_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/auth_db?sslmode=require
NEON_USER_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/user_db?sslmode=require
NEON_VENDOR_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/vendor_db?sslmode=require
NEON_EVENT_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/event_db?sslmode=require
NEON_BOOKING_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/booking_db?sslmode=require
NEON_NOTIFICATION_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/notification_db?sslmode=require
NEON_ANALYTICS_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/analytics_db?sslmode=require
NEON_ADMIN_DATABASE_URL=postgresql://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/admin_db?sslmode=require
```

### Using Drizzle in Services

Each service imports its own database client:

```typescript
// In auth-service
import { db } from './database/client';
import { users } from './database/schema';
import { eq } from 'drizzle-orm';

// Query user by email
const user = await db.select()
  .from(users)
  .where(eq(users.email, 'user@example.com'))
  .limit(1);
```

### Service-Specific Database Configuration

Each service has its own Drizzle configuration:

- `apps/nestjs-services/[service-name]/src/database/drizzle.config.ts`
- `apps/nestjs-services/[service-name]/src/database/schema.ts`
- `apps/nestjs-services/[service-name]/src/database/client.ts`
- `apps/nestjs-services/[service-name]/src/database/seed.ts`

### Data Synchronization

Since each service has its own database, data synchronization is achieved through:

1. **Event-Driven Architecture**: Services publish events to Redpanda when data changes
2. **Event Consumers**: Services consume events to update their local data copies
3. **API Calls**: Direct service-to-service calls for real-time data needs

### Migration Strategy

1. **Development**: Use `db:push` for rapid iteration within each service
2. **Production**: Use `db:generate` → `db:migrate` for versioned migrations per service
3. **Collaboration**: Commit migration files to each service's version control

### Neon Integration

Each service database client is configured to work with Neon PostgreSQL using `@neondatabase/serverless`. Switch between local and Neon by changing the service-specific `*_DATABASE_URL` environment variable.