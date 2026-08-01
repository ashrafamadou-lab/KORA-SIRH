-- Initialisation du conteneur Postgres de dev : rôles + base KORA.
-- (Exécuté une seule fois par docker-entrypoint-initdb.d, en superutilisateur.)
CREATE ROLE kora_migrator LOGIN PASSWORD 'kora_migrator_dev';
CREATE ROLE kora_app LOGIN PASSWORD 'kora_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE kora OWNER kora_migrator;
