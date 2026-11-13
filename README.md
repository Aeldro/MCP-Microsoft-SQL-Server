# MCP SQL Server

Serveur [MCP](https://modelcontextprotocol.io) local qui permet à Claude (Claude Desktop ou Claude Code)
de se connecter à un **SQL Server distant** avec un compte SQL, de **voir toutes les bases auxquelles
ce compte a accès**, d'en explorer la structure et d'y exécuter des requêtes.

- Pilote 100 % JavaScript (`mssql` / `tedious`) : **aucun pilote ODBC à installer**.
- Compatible SQL Server 2012+, Azure SQL Database et Azure SQL Managed Instance.
- **Lecture seule par défaut**, avec plusieurs garde-fous (voir [Sécurité](#sécurité)).

## Outils exposés à Claude

| Outil | Rôle |
| --- | --- |
| `get_server_info` | Version/édition de SQL Server, compte connecté, configuration du serveur MCP |
| `list_databases` | **Toutes les bases en ligne accessibles au compte** (`HAS_DBACCESS`), après filtrage éventuel |
| `list_tables` | Tables et vues d'une base : schéma, nombre de lignes approximatif, description |
| `describe_table` | Colonnes, types, NULL, défauts, PK, index, clés étrangères (sortantes et entrantes), CHECK |
| `list_routines` | Procédures stockées, fonctions, triggers |
| `get_object_definition` | Code T-SQL d'une vue / procédure / fonction / trigger et ses paramètres |
| `search_schema` | Recherche d'un nom de table, colonne ou routine dans une base **ou dans toutes les bases** (option : dans le code source) |
| `execute_query` | Exécute une requête T-SQL et renvoie les résultats en tableau (lignes limitées) |

Chaque outil prend un paramètre `database` : le serveur ouvre une connexion directe vers la base
demandée (pas de `USE`), ce qui fonctionne aussi sur Azure SQL Database.

## Installation

Prérequis : **Node.js 20 ou plus récent** (`node --version`).

```bash
npm install
```

```bash
npm run build
```

Le serveur compilé est `dist/index.js`.

## Préparer le compte SQL

Créez un compte dédié, **en lecture seule**. Le script [sql/create-readonly-login.sql](sql/create-readonly-login.sql)
crée le login, puis, pour chaque base à exposer, l'utilisateur avec `db_datareader` et `VIEW DEFINITION`.

Claude verra **exactement les bases où ce compte a un utilisateur** : pour exposer une nouvelle base,
ajoutez-y l'utilisateur ; pour la masquer, retirez-le (ou utilisez `MSSQL_EXCLUDED_DATABASES`).

## Brancher le serveur dans Claude

### Claude Desktop

> **Important :** Claude Desktop garde sa configuration en mémoire et **réécrit
> `claude_desktop_config.json` pendant qu'il tourne**. Toute modification faite pendant que
> l'application est ouverte est effacée. Modifiez le fichier **application fermée** (clic droit
> sur l'icône près de l'horloge → Quitter).

**Méthode conseillée : le script d'installation.** Dans un terminal PowerShell ordinaire (pas
dans Claude) :

```bash
npm run install-desktop
```

Le script :
1. trouve le bon fichier ;
2. demande le serveur, le login et le mot de passe (la saisie n'est pas affichée) ;
3. teste la connexion et affiche les bases visibles ;
4. attend que Claude Desktop soit fermé ;
5. sauvegarde le fichier, puis ajoute l'entrée sans toucher au reste.

Relancez ensuite Claude Desktop. Options : `--name sql-prod` pour une deuxième entrée,
`--config <chemin>` pour forcer le fichier.

**Méthode manuelle.** Emplacement du fichier :
- version Microsoft Store récente : `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json` ;
- installation classique : `%APPDATA%\Claude\claude_desktop_config.json`.

Ajoutez, Claude Desktop fermé, une clé `mcpServers` à la racine du JSON existant :

```json
{
  "mcpServers": {
    "sqlserver": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\NolandePuydt\\Documents\\Projets de dev\\MCP Microsoft SQL Server\\dist\\index.js"
      ],
      "env": {
        "MSSQL_SERVER": "sql.mon-entreprise.fr",
        "MSSQL_USER": "claude_lecteur",
        "MSSQL_PASSWORD": "votre-mot-de-passe",
        "MSSQL_TRUST_SERVER_CERTIFICATE": "true"
      }
    }
  }
}
```

Redémarrez complètement Claude Desktop (quitter depuis la zone de notification). Les outils
apparaissent dans le menu « Recherche et outils » de la zone de saisie.

> Dans le JSON, les `\` des chemins Windows doivent être doublés.

### Claude Code

```bash
claude mcp add sqlserver --scope user -e MSSQL_SERVER=sql.mon-entreprise.fr -e MSSQL_USER=claude_lecteur -e MSSQL_PASSWORD=votre-mot-de-passe -e MSSQL_TRUST_SERVER_CERTIFICATE=true -- node "C:/Users/NolandePuydt/Documents/Projets de dev/MCP Microsoft SQL Server/dist/index.js"
```

Pour un port autre que 1433, ajoutez `-e MSSQL_PORT=14330`. Vérifiez avec `claude mcp list`, ou `/mcp` dans une session.

### Plusieurs serveurs SQL

Déclarez plusieurs entrées avec des noms différents (`sql-prod`, `sql-recette`...) pointant vers le
même `dist/index.js` avec des variables `env` différentes.

### Garder le mot de passe hors de la configuration Claude

Mettez les variables dans un fichier `.env` (modèle : [.env.example](.env.example)) et demandez à Node de le charger :

```json
"args": [
  "--env-file=C:\\chemin\\vers\\sqlserver.env",
  "C:\\Users\\NolandePuydt\\Documents\\Projets de dev\\MCP Microsoft SQL Server\\dist\\index.js"
]
```

Protégez ce fichier (droits NTFS limités à votre compte).

## Configuration

### Port et instance

Par défaut, le serveur se connecte au port **1433**. Pour un autre port, deux écritures équivalentes :

```json
"env": {
  "MSSQL_SERVER": "sql.mon-entreprise.fr",
  "MSSQL_PORT": "14330"
}
```

```json
"env": {
  "MSSQL_SERVER": "sql.mon-entreprise.fr,14330"
}
```

`hote:14330` est aussi accepté. Si les deux sont donnés, `MSSQL_PORT` l'emporte.

Pour une **instance nommée** (`hote\SQLEXPRESS`) :
- si vous connaissez son port fixe, indiquez-le avec `MSSQL_PORT` : c'est le plus fiable, car le service *SQL Server Browser* et le port UDP 1434 ne sont alors pas nécessaires ;
- sinon, utilisez `MSSQL_SERVER=hote\SQLEXPRESS` (ou `MSSQL_INSTANCE=SQLEXPRESS`) : le port est découvert via *SQL Server Browser*.

Le script `npm run install-desktop` demande le port.

### Toutes les variables

| Variable | Défaut | Description |
| --- | --- | --- |
| `MSSQL_SERVER` | — (obligatoire) | Hôte. Accepte `hote`, `hote,port`, `hote:port`, `hote\instance` |
| `MSSQL_USER` | — (obligatoire) | Login SQL |
| `MSSQL_PASSWORD` | — (obligatoire) | Mot de passe |
| `MSSQL_PORT` | `1433` | Port TCP. Prioritaire sur un port écrit dans `MSSQL_SERVER`. Sans port et avec une instance nommée, découvert via SQL Server Browser |
| `MSSQL_INSTANCE` | — | Instance nommée (ex. `SQLEXPRESS`) |
| `MSSQL_DEFAULT_DATABASE` | `master` | Base utilisée pour lister les bases et lire les infos serveur |
| `MSSQL_ENCRYPT` | `true` | Chiffrement TLS de la connexion |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | `false` | `true` pour accepter un certificat auto-signé (fréquent sur un serveur interne) |
| `MSSQL_CONNECT_TIMEOUT_MS` | `15000` | Délai de connexion |
| `MSSQL_QUERY_TIMEOUT_MS` | `60000` | Délai maximal d'une requête |
| `MSSQL_READONLY` | `true` | `false` pour autoriser les écritures (déconseillé) |
| `MSSQL_DEFAULT_ROWS` | `100` | Lignes renvoyées par défaut par `execute_query` |
| `MSSQL_MAX_ROWS` | `1000` | Plafond du paramètre `max_rows` |
| `MSSQL_MAX_CELL_LENGTH` | `1000` | Au-delà, le contenu d'une cellule est tronqué |
| `MSSQL_DATABASES` | — | Liste blanche (séparée par des virgules) : seules ces bases sont visibles |
| `MSSQL_EXCLUDED_DATABASES` | — | Liste noire de bases à masquer |
| `MSSQL_INCLUDE_SYSTEM_DATABASES` | `false` | Afficher `master`, `model`, `msdb`, `tempdb` |

## Sécurité

1. **La vraie protection, ce sont les droits du compte SQL.** Donnez-lui uniquement `db_datareader`
   (+ `VIEW DEFINITION`), jamais `db_owner` ni `sysadmin`. `get_server_info` signale un compte sysadmin.
2. En mode lecture seule (défaut), `execute_query` :
   - refuse toute requête qui ne commence pas par `SELECT`, `WITH`, `DECLARE`, `SET`, `IF`, `BEGIN` ou `PRINT` ;
   - refuse les mots-clés d'écriture, de DDL et d'administration (`INSERT`, `UPDATE`, `DELETE`, `MERGE`,
     `CREATE`, `ALTER`, `DROP`, `EXEC`, `GRANT`, `OPENROWSET`, `COMMIT`...), en ignorant commentaires,
     chaînes et identifiants entre crochets ;
   - exécute la requête dans une **transaction toujours annulée** (`ROLLBACK`).
3. Chaque requête libre utilise une **connexion dédiée**, fermée ensuite : aucun état de session
   (`SET`, tables `#temp`) ne persiste entre deux requêtes.
4. Les résultats sont lus en flux et la requête est **annulée côté serveur** dès que la limite de
   lignes est atteinte (pas de `SELECT *` qui rapatrie des millions de lignes).
5. Les filtres `MSSQL_DATABASES` / `MSSQL_EXCLUDED_DATABASES` s'appliquent à tous les outils, pas
   seulement à la liste.
6. Le mot de passe est en clair dans la configuration Claude ou dans le `.env` : protégez ces fichiers.
   Les données renvoyées par les outils sont transmises à Claude.

## Tester

Tests unitaires et de protocole (sans SQL Server) :

```bash
npm test
```

Test contre votre vrai serveur : copiez `.env.example` en `.env`, renseignez-le, puis :

```bash
npm run smoke
```

Le script appelle chaque outil comme le ferait Claude et affiche les réponses. Pour cibler une base :
`npm run smoke -- MaBase`.

Inspection interactive avec l'inspecteur MCP officiel (variables lues depuis l'environnement) :

```bash
npm run inspector
```

## Dépannage

| Symptôme | Piste |
| --- | --- |
| `self-signed certificate` / erreur TLS | `MSSQL_TRUST_SERVER_CERTIFICATE=true` |
| `Failed to connect` / délai dépassé | Hôte, port, pare-feu, VPN ; TCP/IP activé dans *SQL Server Configuration Manager* ; service *SQL Server Browser* pour une instance nommée |
| `Login failed` | Identifiants, authentification SQL (mode mixte) activée sur l'instance |
| Une base n'apparaît pas | Le compte n'a pas d'utilisateur dans cette base, la base n'est pas `ONLINE`, ou elle est filtrée |
| Azure SQL : seule une base visible | Normal pour un utilisateur contenu : définir `MSSQL_DEFAULT_DATABASE` |
| L'entrée a disparu de `claude_desktop_config.json` | Le fichier a été modifié pendant que Claude Desktop tournait : refaire la modification application fermée (`npm run install-desktop`) |
| Les outils n'apparaissent pas dans Claude Desktop | Vérifier le JSON, redémarrer complètement l'application, consulter les journaux MCP (Paramètres → Développeur) |

Les messages de diagnostic du serveur sont écrits sur `stderr` (visibles dans les journaux MCP de Claude).

## Structure

```
src/index.ts      démarrage du serveur MCP (stdio)
src/config.ts     lecture des variables d'environnement
src/db.ts         pools de connexions par base, exécution en flux avec limite de lignes
src/tools.ts      définition des 8 outils et requêtes de métadonnées
src/sqlGuard.ts   garde-fou lecture seule
src/format.ts     mise en forme des résultats (tableaux Markdown)
test/             tests unitaires et de protocole
scripts/          test "fumée" contre un vrai serveur
sql/              script de création du compte lecture seule
```
