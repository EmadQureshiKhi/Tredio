-- The API and Autopilot share the `tredio` database (created from POSTGRES_DB); the indexer keeps its own.
CREATE DATABASE tredio_indexer OWNER tredio;
