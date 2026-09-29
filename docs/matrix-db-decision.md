# Research Summary: Choose Database Backend for Matrix Synapse

## Question
Should we use PostgreSQL or SQLite for Matrix Synapse inside the infra container, considering persistence and performance?

## Decision
We will use **PostgreSQL** as the database backend for Matrix Synapse, running as a separate service container alongside Synapse in our Docker infrastructure.

## Rationale
1. **Concurrency and Performance**: Synapse is notoriously heavy on database interactions. SQLite uses file-level locking which severely limits concurrent write performance and can lead to database locked errors under moderate federation traffic. PostgreSQL handles concurrent reads/writes natively and scales much better for Matrix workloads.
2. **Production Readiness**: Even for a self-hosted single-container or multi-container setup replacing Discord/Spacebar, PostgreSQL is the officially recommended production database for Matrix Synapse. SQLite is officially deprecated/discouraged for anything beyond small, ephemeral, single-user instances.
3. **Container Architecture**: Since our goal is a robust infra container setup, running an official Postgres container alongside Synapse via Docker Compose provides clean separation of concerns, easy backups (pg_dump), and robust volume persistence.
