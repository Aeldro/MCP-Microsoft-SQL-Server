import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnlyQuery, ReadOnlyViolation } from "../dist/sqlGuard.js";
import { parseObjectName } from "../dist/tools.js";

const allowed = [
  "SELECT TOP (10) * FROM dbo.Clients",
  "  select name from sys.tables",
  "WITH cte AS (SELECT 1 AS x) SELECT * FROM cte",
  "DECLARE @d date = '2024-01-01'; SELECT * FROM Ventes WHERE dt >= @d",
  "SET NOCOUNT ON; SELECT 1",
  "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SELECT COUNT(*) FROM t",
  "SELECT 'DELETE FROM t; DROP TABLE x' AS texte",
  "SELECT [Update], [Delete] FROM [Insert]",
  "SELECT * FROM t -- DROP TABLE t",
  "SELECT * FROM t /* EXEC xp_cmdshell 'dir' /* imbriqué */ */",
  "SELECT a, b INTO #tmp FROM t; SELECT * FROM #tmp",
  "SELECT \"Select\" FROM t",
  "SELECT N'l''apostrophe ; DELETE' FROM t",
  "(SELECT 1) UNION (SELECT 2)",
  "SELECT @update = 1",
  "IF EXISTS (SELECT 1 FROM t) SELECT 'oui' ELSE SELECT 'non'",
];

const rejected = [
  "DELETE FROM dbo.Clients",
  "UPDATE t SET a = 1",
  "INSERT INTO t VALUES (1)",
  "SELECT 1; DROP TABLE t",
  "SELECT * INTO dbo.copie FROM t",
  "EXEC sp_who",
  "sp_configure 'show advanced options', 1",
  "TRUNCATE TABLE t",
  "SELECT 1; COMMIT; DELETE FROM t",
  "MERGE t USING s ON t.id = s.id WHEN MATCHED THEN DELETE;",
  "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')",
  "WITH x AS (SELECT 1 AS a) DELETE FROM x",
  "USE master; SELECT 1",
  "GRANT SELECT ON t TO public",
  "BEGIN TRAN; SELECT 1",
  "DECLARE @s nvarchar(100) = 'DROP TABLE t'; EXECUTE (@s)",
  "",
  "   -- juste un commentaire",
];

for (const sql of allowed) {
  test(`autorisé : ${sql}`, () => {
    assert.doesNotThrow(() => assertReadOnlyQuery(sql));
  });
}

for (const sql of rejected) {
  test(`refusé : ${JSON.stringify(sql)}`, () => {
    assert.throws(() => assertReadOnlyQuery(sql), ReadOnlyViolation);
  });
}

test("parseObjectName", () => {
  assert.deepEqual(parseObjectName("Clients"), { schema: null, name: "Clients" });
  assert.deepEqual(parseObjectName("dbo.Clients"), { schema: "dbo", name: "Clients" });
  assert.deepEqual(parseObjectName("[ventes].[Lignes.Commande]"), { schema: "ventes", name: "Lignes.Commande" });
  assert.deepEqual(parseObjectName("MaBase.dbo.T"), { schema: "dbo", name: "T" });
  assert.deepEqual(parseObjectName("T", "rh"), { schema: "rh", name: "T" });
  assert.deepEqual(parseObjectName("[a]]b]"), { schema: null, name: "a]b" });
});
