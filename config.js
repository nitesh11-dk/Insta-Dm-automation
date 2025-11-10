import dotenv from "dotenv";
dotenv.config();

export async function loadConfig() {
  const USERNAME = process.env.LOGIN_USERNAME;

  if (!USERNAME) {
    console.error("❌ LOGIN_USERNAME not found in .env!");
    process.exit(1);
  }

  // Direct static values (no DB fetch)
  const PORT = 3001;
  const TABLE = "leads_1";

  const WEBHOOK_LOGIN = process.env.WEBHOOK_LOGIN;
  const WEBHOOK_DM = process.env.WEBHOOK_DM;

  console.log(
    `✅ Loaded config for '${USERNAME}': PORT=${PORT}, TABLE=${TABLE}`
  );

  return {
    USERNAME,
    PORT,
    TABLE,
    WEBHOOK_LOGIN,
    WEBHOOK_DM,
  };
}
