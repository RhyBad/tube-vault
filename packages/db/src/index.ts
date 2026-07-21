// @tubevault/db — re-export of the generated Prisma client.
//
// DB row types (BigInt, Bytes, Prisma enums) live here and are BACKEND-ONLY:
// apps/api and apps/worker import from `@tubevault/db` instead of reaching into
// `@prisma/client` directly. Browser-safe transport types (DTOs, string-union
// enums, SSE frames) live in @tubevault/types — the web app depends only on that.
export * from '@prisma/client';
export { PrismaClient } from '@prisma/client';
