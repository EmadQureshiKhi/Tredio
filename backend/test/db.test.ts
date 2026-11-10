import { expect, test } from "bun:test";
import { sslFor } from "../src/db";

test("TLS follows the URL, and otherwise stays off only on this machine and the Compose network", () => {
  expect(sslFor("postgres://tredio:pw@localhost:5432/tredio")).toBe(false);
  expect(sslFor("postgres://tredio:pw@127.0.0.1/tredio")).toBe(false);
  expect(sslFor("postgres://tredio:pw@postgres:5432/tredio")).toBe(false);
  expect(sslFor("postgres://u:pw@db.example.supabase.co:5432/postgres")).toBe("require");
  expect(sslFor("postgres://u:pw@10.0.0.5:5432/tredio")).toBe("require");
  expect(sslFor("postgres://u:pw@db.example.com/tredio?sslmode=disable")).toBe(false);
  expect(sslFor("postgres://u:pw@postgres/tredio?sslmode=require")).toBe("require");
  expect(sslFor("postgres://u:pw@db.example.com/tredio?sslmode=verify-ca")).toBe("require");
});
