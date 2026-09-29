import 'dotenv/config';

// Point connection string to dedicated test database instance
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
