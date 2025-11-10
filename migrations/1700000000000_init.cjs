/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Drop existing tables if they exist
  pgm.sql(`
      DROP TABLE IF EXISTS leads_1;
      DROP TABLE IF EXISTS accounts;
    `);

  // Create leads_1 table
  pgm.createTable("leads_1", {
    id: "id",
    username: { type: "varchar(100)", notNull: true },
    message: { type: "text" },
    status: { type: "varchar(255)" },
    time_stamp: { type: "varchar(100)", default: null },
  });

  // Create simplified accounts table
  pgm.createTable("accounts", {
    id: "id",
    username: { type: "varchar(100)", notNull: true, unique: true },
    password: { type: "varchar(100)", notNull: true },
  });
};

exports.down = (pgm) => {
  pgm.dropTable("leads_1", { ifExists: true });
  pgm.dropTable("accounts", { ifExists: true });
};
