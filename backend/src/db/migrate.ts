import { connect, migrate } from "./index";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const sql = connect(url, 1);
const files = await migrate(sql);
console.log(`applied ${files.join(", ")}`);
await sql.end();
