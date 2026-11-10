import { expect, test } from "bun:test";
import { sslFor } from "../src/db";

test("TLS follows the URL, and otherwise stays off only on this machine and the Compose network", () => {
  expect(sslFor("postgres://tredio:pw@localhost:5432/tredio")).toBe(false);
  expect(sslFor("postgres://tredio:pw@postgres:5432/tredio")).toBe(false);
  expect(sslFor("postgres://u:pw@db.example.com:5432/tredio")).toBe("require");
  expect(sslFor("postgres://u:pw@db.example.com/tredio?sslmode=disable")).toBe(false);
});
