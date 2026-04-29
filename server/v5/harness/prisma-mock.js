"use strict";
// In-memory prisma mock — implements the subset of prisma.user.* used by
// server/v5/db.js. Each test gets a fresh instance.

function createMockPrisma() {
  // users keyed by id (numeric autoincrement). A second index by telegramId
  // for fast lookup. Each row: { id, telegramId, webToken, v4State, v4History }.
  const byId = new Map();
  const byTg = new Map();
  let nextId = 1;

  return {
    $connect: async () => {},
    $disconnect: async () => {},
    user: {
      async findUnique(args) {
        const where = args && args.where;
        if (!where) return null;
        if (where.id !== undefined) return byId.get(where.id) || null;
        if (where.telegramId !== undefined) return byTg.get(where.telegramId) || null;
        return null;
      },
      async create(args) {
        const data = args && args.data ? args.data : {};
        const id = nextId++;
        const row = Object.assign({
          id, telegramId: null, webToken: null, v4State: null, v4History: null,
        }, data);
        byId.set(id, row);
        if (row.telegramId) byTg.set(row.telegramId, row);
        return row;
      },
      async update(args) {
        const where = args && args.where;
        const data = args && args.data ? args.data : {};
        const id = where && where.id;
        const row = byId.get(id);
        if (!row) throw new Error("mock prisma: user not found id=" + id);
        Object.assign(row, data);
        if (row.telegramId) byTg.set(row.telegramId, row);
        return row;
      },
      async findMany(args) {
        const out = [];
        for (const row of byId.values()) out.push(row);
        return out;
      },
    },
  };
}

module.exports = { createMockPrisma };
