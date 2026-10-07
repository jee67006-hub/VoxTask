import { loadEnvFile } from "node:process";
import { stitch } from "@google/stitch-sdk";

try {
  loadEnvFile(".env.local");
  if (!process.env.STITCH_API_KEY) throw new Error("Add STITCH_API_KEY to .env.local.");
  const projects = await stitch.projects();
  console.log(`Stitch connected. Accessible projects: ${projects.length}`);
} catch (error) {
  console.error(error?.code === "AUTH_FAILED" ? "Stitch rejected the API key." : error?.message || "Stitch connection failed.");
  process.exitCode = 1;
}
