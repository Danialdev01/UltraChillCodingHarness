-- Runs once, on the mysql volume's first initialisation.
-- This server holds development databases only, so the `dev` account the
-- image creates may make and drop as many as projects need.
GRANT ALL PRIVILEGES ON *.* TO 'dev'@'%';
FLUSH PRIVILEGES;
