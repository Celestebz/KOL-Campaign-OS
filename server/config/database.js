const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
dotenv.config();

const {
  DB_HOST = '127.0.0.1',
  DB_PORT = 3306,
  DB_USER = 'kol_user',
  DB_PASSWORD = 'kol_password',
  DB_NAME = 'kol_campaign_os'
} = process.env;

module.exports = {
  host: DB_HOST,
  port: Number(DB_PORT),
  username: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  dialect: 'mysql',
  dialectOptions: {
    charset: 'utf8mb4'
  },
  define: {
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
    timestamps: true,
    underscored: true,
    engine: 'InnoDB'
  },
  pool: {
    max: Number(process.env.DB_CONNECTION_LIMIT || 10),
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  logging: process.env.DB_LOGGING === 'true' ? console.log : false
};
