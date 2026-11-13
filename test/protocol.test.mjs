// Test de bout en bout du protocole MCP (sans SQL Server) : le serveur démarre,
// expose ses outils, et renvoie une erreur lisible quand le serveur SQL est injoignable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      MSSQL_SERVER: "127.0.0.1",
      MSSQL_PORT: "1", // port fermé : la connexion échoue immédiatement
      MSSQL_USER: "test",
      MSSQL_PASSWORD: "test",
      MSSQL_CONNECT_TIMEOUT_MS: "3000",
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("expose les outils attendus", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "describe_table",
      "execute_query",
      "get_object_definition",
      "get_server_info",
      "list_databases",
      "list_routines",
      "list_tables",
      "search_schema",
    ]);
    const exec = tools.find((t) => t.name === "execute_query");
    assert.equal(exec.annotations.readOnlyHint, true);
    assert.ok(exec.inputSchema.properties.database);
    assert.ok(exec.inputSchema.properties.query);
    assert.ok(client.getInstructions()?.includes("list_databases"));
  } finally {
    await client.close();
  }
});

test("refuse une requête d'écriture sans se connecter", async () => {
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "execute_query",
      arguments: { database: "Ventes", query: "DELETE FROM dbo.Clients" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /DELETE/);
  } finally {
    await client.close();
  }
});

test("refuse une base hors liste blanche", async () => {
  const client = await connect({ MSSQL_DATABASES: "Ventes,RH" });
  try {
    const result = await client.callTool({
      name: "list_tables",
      arguments: { database: "Compta" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /n'est pas autorisée/);
  } finally {
    await client.close();
  }
});

test("erreur de connexion explicite", async () => {
  const client = await connect();
  try {
    const result = await client.callTool({ name: "list_databases", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Connexion à la base "master" impossible/);
    assert.match(result.content[0].text, /injoignable/);
  } finally {
    await client.close();
  }
});

test("mode lecture/écriture : annotations adaptées", async () => {
  const client = await connect({ MSSQL_READONLY: "false" });
  try {
    const { tools } = await client.listTools();
    const exec = tools.find((t) => t.name === "execute_query");
    assert.equal(exec.annotations.readOnlyHint, false);
    assert.equal(exec.annotations.destructiveHint, true);
  } finally {
    await client.close();
  }
});
