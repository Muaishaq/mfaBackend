const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: ['error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  }
});

// Prepared statements are disabled for PgBouncer compatibility via DATABASE_URL parameters

module.exports = prisma;
