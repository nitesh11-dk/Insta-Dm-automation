import dotenv from "dotenv";
import { pool } from "./db.js"; // Make sure you have your pool setup here
dotenv.config();

export async function loadConfig() {
  const USERNAME = process.env.LOGIN_USERNAME;

  if (!USERNAME) {
    console.error("❌ LOGIN_USERNAME not found in .env!");
    process.exit(1);
  }

  try {
    // Fetch port and table_name from accounts table
    const result = await pool.query(
      "SELECT port, table_name FROM accounts WHERE username = $1 LIMIT 1",
      [USERNAME]
    );

    if (result.rows.length === 0) {
      console.error(`❌ No account found for username: ${USERNAME}`);
      process.exit(1);
    }

    const { port: PORT, table_name: TABLE } = result.rows[0];

    const WEBHOOK_LOGIN = process.env.WEBHOOK_LOGIN;
    const WEBHOOK_DM = process.env.WEBHOOK_DM;

    console.log(`✅ Loaded config for '${USERNAME}': PORT=${PORT}, TABLE=${TABLE}`);

    return {
      USERNAME,
      PORT,
      TABLE,
      WEBHOOK_LOGIN,
      WEBHOOK_DM,
    };
  } catch (err) {
    console.error("❌ Error loading config from database:", err);
    process.exit(1);
  }
}
