#!/usr/bin/env node
/**
 * Serveur MCP SQL Server (transport stdio) pour Claude Desktop / Claude Code.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { registerTools } from "./tools.js";

const VERSION = "1.0.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = new Database(config);

  const server = new McpServer(
    { name: "sqlserver", version: VERSION },
    {
      instructions: [
        `Ce serveur donne accès à l'instance SQL Server "${config.server}" avec le compte "${config.user}".`,
        "Démarche conseillée : list_databases pour découvrir les bases accessibles, puis list_tables / search_schema pour trouver les objets,",
        "describe_table pour comprendre leur structure et leurs relations, et enfin execute_query.",
        "Écrivez du T-SQL (dialecte SQL Server) : TOP (n) ou OFFSET ... FETCH au lieu de LIMIT, crochets [ ] pour les identifiants spéciaux.",
        "Préférez des requêtes ciblées (colonnes nommées, filtres, agrégats) plutôt que SELECT * sur de grandes tables.",
        config.readOnly
          ? "Le serveur est en LECTURE SEULE : seules les requêtes de lecture sont acceptées."
          : "Le serveur est en LECTURE/ÉCRITURE : demandez confirmation à l'utilisateur avant toute modification de données ou de schéma.",
      ].join(" "),
    },
  );

  registerTools(server, db, config);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await db.closeAll().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
  console.error(
    `[mcp-sqlserver] prêt — serveur ${config.server}${config.instanceName ? `\\${config.instanceName}` : ""}${
      config.port ? `:${config.port}` : ""
    }, compte ${config.user}, ${config.readOnly ? "lecture seule" : "lecture/écriture"}.`,
  );
}

main().catch((err) => {
  console.error(`[mcp-sqlserver] démarrage impossible : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
