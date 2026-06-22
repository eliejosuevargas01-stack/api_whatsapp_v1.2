CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE client_credentials (
    id SERIAL PRIMARY KEY,
    -- UUID gerado automaticamente
    client_id UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
    -- HASH gerado pelo Bcrypt (nunca armazenar texto limpo)
    client_secret_hash VARCHAR(255) NOT NULL,
    -- Identificador externo (ex: "user_99")
    external_user_id VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_client_credentials_client_id ON client_credentials(client_id);
