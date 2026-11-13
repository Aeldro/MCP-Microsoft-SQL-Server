// Ajoute (ou met à jour) le serveur MCP SQL Server dans la configuration de Claude Desktop.
//
// À lancer dans un terminal PowerShell ordinaire, Claude Desktop FERMÉ : quand
// l'application est ouverte, elle réécrit son fichier de configuration depuis sa
// mémoire et efface toute modification faite pendant ce temps.
//
//   node scripts/install-claude-desktop.mjs
//
// Options :
//   --config <chemin>   fichier de configuration à modifier (détecté sinon)
//   --name <nom>        nom de l'entrée (défaut : sqlserver)
//   --no-test           ne pas tester la connexion avant d'enregistrer
//   --force             écrire même si Claude Desktop est ouvert (déconseillé)
//
// Les questions proposent par défaut les variables MSSQL_* déjà définies, par exemple :
//   node --env-file=.env scripts/install-claude-desktop.mjs
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = join(projectDir, "dist", "index.js");

// --- Arguments -------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// --- Saisie ----------------------------------------------------------------
const isTTY = Boolean(process.stdin.isTTY);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });

// Masquage de la saisie du mot de passe : on coupe l'écho de readline.
let muted = false;
const writeToOutput = rl._writeToOutput?.bind(rl);
if (writeToOutput) {
  rl._writeToOutput = (s) => {
    if (!muted) writeToOutput(s);
  };
}

// File de lignes : aucune réponse n'est perdue, même si elles arrivent d'un coup.
const pendingLines = [];
const waiters = [];
let inputClosed = false;
rl.on("line", (line) => {
  const waiter = waiters.shift();
  if (waiter) waiter.resolve(line);
  else pendingLines.push(line);
});
rl.on("close", () => {
  inputClosed = true;
  for (const waiter of waiters.splice(0)) waiter.reject(new Error("Saisie interrompue."));
});

function nextLine() {
  if (pendingLines.length > 0) return Promise.resolve(pendingLines.shift());
  if (inputClosed) return Promise.reject(new Error("Saisie interrompue."));
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

function showPrompt(text) {
  if (inputClosed) {
    process.stdout.write(text);
  } else {
    rl.setPrompt(text);
    rl.prompt();
  }
}

async function ask(question, fallback) {
  showPrompt(`${question}${fallback ? ` [${fallback}]` : ""} : `);
  const answer = (await nextLine()).trim();
  if (!isTTY) process.stdout.write("\n");
  return answer || fallback || "";
}

async function askHidden(question, hasFallback) {
  showPrompt(`${question}${hasFallback ? " [Entrée = valeur de MSSQL_PASSWORD]" : ""} : `);
  muted = isTTY;
  try {
    return await nextLine();
  } finally {
    muted = false;
    process.stdout.write("\n");
  }
}

async function askYesNo(question, fallback) {
  const answer = (await ask(`${question} (o/n)`, fallback ? "o" : "n")).toLowerCase();
  return ["o", "oui", "y", "yes"].includes(answer);
}

// --- Fichier de configuration -------------------------------------------------
function findConfigPath() {
  const explicit = option("--config");
  if (explicit) return resolve(explicit);

  const local = process.env.LOCALAPPDATA ?? "";
  const roaming = process.env.APPDATA ?? "";
  const candidates = [];

  // Versions récentes (Microsoft Store) : données déplacées hors du paquet.
  const dataRoot = join(local, "Claude-Data");
  if (existsSync(dataRoot)) {
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith("claude")) {
        candidates.push(join(dataRoot, entry.name, "claude_desktop_config.json"));
      }
    }
  }
  // Version Microsoft Store (ancien emplacement, dans le paquet).
  const packages = join(local, "Packages");
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory() && /^Claude_/i.test(entry.name)) {
        candidates.push(join(packages, entry.name, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
      }
    }
  }
  // Installation classique.
  candidates.push(join(roaming, "Claude", "claude_desktop_config.json"));

  const existing = candidates
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (existing.length > 0) return existing[0];

  // Aucun fichier : on le crée dans le premier dossier de données existant.
  const dir = candidates.map(dirname).find((d) => existsSync(d)) ?? join(roaming, "Claude");
  return join(dir, "claude_desktop_config.json");
}

function claudeDesktopRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Claude.exe" /NH', { encoding: "utf8" });
    return /claude\.exe/i.test(out);
  } catch {
    return false;
  }
}

async function waitForClaudeToClose() {
  if (flag("--force") || !claudeDesktopRunning()) return;
  console.log(
    "\nClaude Desktop est ouvert. Quittez-le complètement : clic droit sur son icône près de l'horloge → Quitter.",
  );
  console.log("(S'il reste ouvert, il effacera la modification.) En attente de sa fermeture…");
  while (claudeDesktopRunning()) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("Claude Desktop est fermé.\n");
}

// --- Test de connexion -------------------------------------------------------
async function testConnection(env) {
  const sdk = (p) => new URL(`../node_modules/@modelcontextprotocol/sdk/dist/esm/${p}`, import.meta.url).href;
  const { Client } = await import(sdk("client/index.js"));
  const { StdioClientTransport } = await import(sdk("client/stdio.js"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: { ...process.env, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "install-claude-desktop", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "list_databases", arguments: {} });
    return { ok: !result.isError, text: result.content.map((c) => c.text).join("\n") };
  } finally {
    await client.close();
  }
}

// --- Programme principal -----------------------------------------------------
async function main() {
  if (!existsSync(serverScript)) {
    console.error(`Serveur non compilé (${serverScript} introuvable). Lancez d'abord : npm run build`);
    process.exit(1);
  }

  const configPath = findConfigPath();
  console.log(`Configuration Claude Desktop : ${configPath}\n`);

  const name = option("--name") ?? "sqlserver";
  const server = await ask("Serveur SQL (hote, hote,port ou hote\\instance)", process.env.MSSQL_SERVER);
  // Port : inutile de le demander s'il est déjà dans l'adresse (hote,port / hote:port).
  let port = process.env.MSSQL_PORT;
  if (!/[,:]\d+$/.test(server)) {
    const isInstance = server.includes("\\");
    port = await ask(
      isInstance ? "Port TCP (Entrée = découverte via SQL Server Browser)" : "Port TCP",
      port ?? (isInstance ? "" : "1433"),
    );
    if (port && !/^\d{1,5}$/.test(port)) {
      console.error(`\nPort invalide : "${port}". Rien n'a été modifié.`);
      process.exit(1);
    }
  }
  const user = await ask("Login SQL", process.env.MSSQL_USER);
  const typedPassword = await askHidden("Mot de passe (non affiché)", Boolean(process.env.MSSQL_PASSWORD));
  const password = typedPassword || process.env.MSSQL_PASSWORD || "";
  const trustCert = await askYesNo(
    "Accepter un certificat auto-signé (fréquent sur un serveur interne)",
    /^(1|true|yes|oui)$/i.test(process.env.MSSQL_TRUST_SERVER_CERTIFICATE ?? ""),
  );

  if (!server || !user || !password) {
    console.error("\nServeur, login et mot de passe sont obligatoires. Rien n'a été modifié.");
    process.exit(1);
  }

  const env = { MSSQL_SERVER: server, MSSQL_USER: user, MSSQL_PASSWORD: password };
  if (port && port !== "1433") env.MSSQL_PORT = port;
  if (trustCert) env.MSSQL_TRUST_SERVER_CERTIFICATE = "true";
  for (const key of ["MSSQL_DATABASES", "MSSQL_EXCLUDED_DATABASES", "MSSQL_DEFAULT_DATABASE", "MSSQL_READONLY"]) {
    if (process.env[key]) env[key] = process.env[key];
  }

  if (!flag("--no-test")) {
    console.log("\nTest de connexion…");
    const test = await testConnection(env);
    console.log(test.text.split("\n").slice(0, 25).join("\n"));
    if (!test.ok && !(await askYesNo("\nLa connexion a échoué. Enregistrer quand même", false))) {
      console.log("Rien n'a été modifié.");
      process.exit(1);
    }
  }

  await waitForClaudeToClose();

  // Relecture APRÈS la fermeture de Claude : on part de la dernière version écrite par l'application.
  let config = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8").replace(/^﻿/, "");
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      console.error(`Le fichier existant n'est pas un JSON valide (${err.message}). Rien n'a été modifié.`);
      process.exit(1);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    copyFileSync(configPath, `${configPath}.bak-${stamp}`);
    console.log(`Sauvegarde : ${configPath}.bak-${stamp}`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  const replaced = Boolean(config.mcpServers?.[name]);
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: { command: process.execPath, args: [serverScript], env } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const check = JSON.parse(readFileSync(configPath, "utf8"));
  if (!check.mcpServers?.[name]) throw new Error("Vérification après écriture échouée.");

  console.log(`\n✔ Entrée "${name}" ${replaced ? "mise à jour" : "ajoutée"}. Vous pouvez relancer Claude Desktop.`);
}

main()
  .catch((err) => {
    console.error(`\nErreur : ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
