# OpenLance

A modern, scalable freelancer-client marketplace built with Bun, Elysia, and a microservices architecture.

## Tech Stack

- **Runtime**: Bun
- **API Framework**: Elysia
- **Monorepo**: Turborepo + npm workspaces
- **PostgreSQL ORM**: Prisma
- **MongoDB ODM**: Mongoose
- **Cache**: Redis (ioredis)
- **Logger**: Pino

## Project Structure

```
openlance/
├── apps/
│   └── gateway/          # API Gateway
├── services/
│   ├── user-service/     # User management
│   ├── project-service/  # Project management
│   └── notification-service/
├── packages/
│   ├── config/           # Shared ESLint, TypeScript configs
│   ├── shared/           # Types, utilities, constants
│   ├── database/         # Prisma (PostgreSQL)
│   ├── mongodb/          # Mongoose models
│   ├── cache/            # Redis client
│   └── logger/           # Pino logger
└── docker/
    └── docker-compose.yml
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Docker](https://www.docker.com/) (for databases)
- Node.js >= 20 (for npm)

### Installation

```bash
# Install dependencies
npm install

# Start infrastructure (PostgreSQL, MongoDB, Redis)
cd docker && docker compose up -d

# Copy environment file
cp .env.example .env

# Generate Prisma client
npm run -w @openlance/database db:generate

# Run database migrations
npm run -w @openlance/database db:push
```

### Development

```bash
# Start all services in development mode
npm run dev

# Start specific service
npm run dev --filter=@openlance/gateway
npm run dev --filter=@openlance/user-service

# Type check
npm run type-check

# Lint
npm run lint

# Format code
npm run format
```

### Available Scripts

| Command              | Description                      |
| -------------------- | -------------------------------- |
| `npm run dev`        | Start all services in watch mode |
| `npm run build`      | Build all packages               |
| `npm run lint`       | Lint all packages                |
| `npm run type-check` | Type-check all packages          |
| `npm run format`     | Format code with Prettier        |
| `npm run clean`      | Clean build artifacts            |

## Services

| Service              | Port | Description                              |
| -------------------- | ---- | ---------------------------------------- |
| Gateway              | 3000 | API Gateway, routes requests to services |
| User Service         | 3001 | User registration, auth, profiles        |
| Project Service      | 3002 | Project CRUD, listings                   |
| Notification Service | 3003 | Notifications, messages                  |

## Environment Variables

See [.env.example](.env.example) for all available environment variables.

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

```
feat(scope): add new feature
fix(scope): fix bug
docs(scope): update documentation
```

## License

MIT
