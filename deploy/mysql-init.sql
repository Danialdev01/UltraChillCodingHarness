-- Runs once, on the mysql volume's first initialisation.
-- This server holds development databases only, so the `dev` account the
-- image creates may make and drop as many as projects need.
-- Everything a project's schema needs, and none of the server-administration
-- privileges (FILE, SUPER, SHUTDOWN, PROCESS, CREATE USER, GRANT OPTION):
-- those reach the container's filesystem and other sessions, not just data.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW,
      CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, SHOW DATABASES
  ON *.* TO 'dev'@'%';
FLUSH PRIVILEGES;
