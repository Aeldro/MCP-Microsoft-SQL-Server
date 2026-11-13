/*
  Création d'un compte SQL en lecture seule pour le serveur MCP.
  À exécuter par un administrateur (SSMS, Azure Data Studio, sqlcmd...).

  Le serveur MCP montrera à Claude exactement les bases où ce compte possède un
  utilisateur : ajoutez ou retirez l'utilisateur d'une base pour l'exposer ou la masquer.
*/

-- 1) Login au niveau de l'instance --------------------------------------------
USE [master];
GO
CREATE LOGIN [claude_lecteur]
    WITH PASSWORD = N'<MotDePasseFort!>',
         CHECK_POLICY = ON,
         DEFAULT_DATABASE = [master];
GO

-- 2) Pour CHAQUE base à rendre visible : répéter ce bloc ----------------------
USE [MaBase];   -- <-- nom de la base
GO
CREATE USER [claude_lecteur] FOR LOGIN [claude_lecteur];
ALTER ROLE [db_datareader] ADD MEMBER [claude_lecteur];   -- lecture de toutes les tables/vues
GRANT VIEW DEFINITION TO [claude_lecteur];                -- lecture du code des vues/procédures
-- Optionnel : masquer des données sensibles
-- DENY SELECT ON [dbo].[Salaires] TO [claude_lecteur];
-- DENY SELECT ON SCHEMA::[rh] TO [claude_lecteur];
GO

/*
  Azure SQL Database (pas d'accès à master pour un utilisateur contenu) :
    -- dans la base cible
    CREATE USER [claude_lecteur] WITH PASSWORD = N'<MotDePasseFort!>';
    ALTER ROLE [db_datareader] ADD MEMBER [claude_lecteur];
    GRANT VIEW DEFINITION TO [claude_lecteur];
  puis définir MSSQL_DEFAULT_DATABASE=<la base> dans la configuration du serveur MCP.
*/
