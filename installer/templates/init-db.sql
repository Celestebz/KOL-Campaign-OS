-- Idempotent database/user bootstrap for the bundled MariaDB.
-- Runs as root over 127.0.0.1 at every service start; safe to re-run.
CREATE DATABASE IF NOT EXISTS kol_campaign_os
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'kol_user'@'%' IDENTIFIED BY 'kol_password';
CREATE USER IF NOT EXISTS 'kol_user'@'localhost' IDENTIFIED BY 'kol_password';
GRANT ALL PRIVILEGES ON `kol_campaign_os`.* TO 'kol_user'@'%';
GRANT ALL PRIVILEGES ON `kol_campaign_os`.* TO 'kol_user'@'localhost';
-- Test databases used by `npm test` (node --test) in development.
CREATE USER IF NOT EXISTS 'kol_user'@'%' IDENTIFIED BY 'kol_password';
GRANT ALL PRIVILEGES ON `kol_campaign\_os\_%\_test`.* TO 'kol_user'@'%';
GRANT ALL PRIVILEGES ON `kol_campaign\_os\_%\_test`.* TO 'kol_user'@'localhost';
FLUSH PRIVILEGES;
