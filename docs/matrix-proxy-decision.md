# Research & Design Summary: Configure Element Web and Synapse Reverse Proxy

## Question
How should Nginx or internal routing inside the infra container expose both Synapse (federation/client APIs) and Element Web under a single or grouped port/domain?

## Decision
We will extend our Docker Compose setup (`docker-compose.infra.yml`) to include:
1. **Matrix Synapse container** (`matrixdotorg/synapse:latest`), connected to a PostgreSQL container and exposing Synapse's ports internally.
2. **Element Web container** (`vectorim/element-web:latest`), serving the static web client.
3. **Nginx reverse proxy container** (or integrated routing) that maps:
   - `/` to Element Web.
   - `/_matrix` and `/_synapse` to the Synapse server container.
   - Configures the well-known delegation endpoint (`/.well-known/matrix/client`) to support federation and custom client discovery.

## Configuration Details
- **Synapse port**: 8008
- **Element Web**: Static files served via Nginx on port 80/443 or a designated gateway port (e.g., 8000).
- **Proxy Rules**:
  ```nginx
  server {
      listen 80;
      server_name localhost;

      location / {
          proxy_pass http://element-web/;
          proxy_set_header Host $host;
      }

      location ~ ^(/_matrix|/_synapse) {
          proxy_pass http://synapse:8008;
          proxy_set_header X-Forwarded-For $remote_addr;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header Host $host;
          client_max_body_size 50M;
      }
  }
  ```
