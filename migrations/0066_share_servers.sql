-- Owner/admin-configurable share endpoints. A single instance can be reached
-- through several addresses (public domain, reverse proxy, LAN IP); the admin
-- picks the default one used when generating public share links.
ALTER TABLE instance_settings ADD COLUMN share_servers TEXT;
ALTER TABLE instance_settings ADD COLUMN default_share_server_url TEXT;
