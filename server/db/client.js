// server/db/client.js
// Prisma client singleton — import this everywhere you need DB access.

"use strict";

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["query", "error"] : ["error"],
});

module.exports = prisma;
