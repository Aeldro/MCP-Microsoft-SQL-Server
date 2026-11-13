// Test "fumée" contre un vrai SQL Server : démarre le serveur MCP comme le ferait
// Claude, puis appelle chaque outil et affiche les réponses.
//
// Usage :  npm run smoke              (lit le fichier .env à la racine s'il existe)
//          npm run smoke -- MaBase    (force la base à explorer)
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  env: process.env,
  cwd: root,
  stderr: "inherit",
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
async function call(name, args = {}) {
  console.log(`\n━━━ ${name} ${JSON.stringify(args)}`);
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text).join("\n");
  console.log(text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length} caractères)` : text);
  if (result.isError) failures++;
  return { text, isError: result.isError };
}

try {
  await call("get_server_info");
  const dbs = await call("list_databases");

  let database = process.argv[2];
  if (!database && !dbs.isError) {
    // Première ligne de données du tableau Markdown renvoyé par list_databases.
    const firstRow = dbs.text.split("\n").find((l, i, all) => l.startsWith("| ") && all[i - 1]?.startsWith("| ---"));
    database = firstRow?.split("|")[1]?.trim();
  }

  if (database) {
    const tables = await call("list_tables", { database, limit: 10 });
    const firstTable = tables.text
      .split("\n")
      .find((l, i, all) => l.startsWith("| ") && all[i - 1]?.startsWith("| ---"));
    if (firstTable) {
      const [, schema, name] = firstTable.split("|").map((s) => s.trim());
      await call("describe_table", { database, table: `${schema}.${name}` });
      await call("execute_query", { database, query: `SELECT TOP (5) * FROM [${schema}].[${name}]` });
    }
    await call("list_routines", { database, limit: 10 });
    await call("execute_query", { database, query: "SELECT DB_NAME() AS base, SYSDATETIME() AS maintenant, USER_NAME() AS utilisateur" });
    const refused = await call("execute_query", { database, query: "DELETE FROM dbo.N_Existe_Pas" });
    if (refused.isError) failures--; // refus attendu en mode lecture seule
  }
  await call("search_schema", { pattern: "id", limit: 10 });
} finally {
  await client.close();
}

console.log(failures === 0 ? "\n✔ Tous les appels ont réussi." : `\n✖ ${failures} appel(s) en erreur.`);
process.exit(failures === 0 ? 0 : 1);
